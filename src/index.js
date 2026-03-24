const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const dotenv = require('dotenv');

dotenv.config();
puppeteerExtra.use(StealthPlugin());

const DEBUG = process.env.DEBUG === 'true';
const outputDir = path.join(__dirname, '../output');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function debug(...args) {
  if (DEBUG) console.log('[DEBUG]', ...args);
}

function sanitizeCookies(cookies) {
  const allowedFields = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'];
  return cookies.map(cookie => {
    const sanitized = {};
    for (const field of allowedFields) {
      if (cookie[field] !== undefined) {
        sanitized[field] = cookie[field];
      }
    }
    if (cookie.expirationDate && !sanitized.expires) {
      sanitized.expires = cookie.expirationDate;
    }
    if (sanitized.domain && !sanitized.domain.startsWith('.') && !sanitized.domain.startsWith('www')) {
      sanitized.domain = '.' + sanitized.domain;
    }
    return sanitized;
  });
}

function loadCookies() {
  let rawCookies = null;

  if (process.env.UDEMY_COOKIES) {
    try {
      rawCookies = JSON.parse(process.env.UDEMY_COOKIES);
    } catch (e) {
      console.error('Failed to parse UDEMY_COOKIES:', e.message);
    }
  }

  if (!rawCookies) {
    const cookiesPath = path.join(__dirname, '../cookies.json');
    if (fs.existsSync(cookiesPath)) {
      try {
        rawCookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
      } catch (e) {
        console.error('Failed to parse cookies.json:', e.message);
      }
    }
  }

  return rawCookies ? sanitizeCookies(rawCookies) : null;
}

async function extractCourseId(page) {
  return await page.evaluate(() => {
    // Body attribute (regular Udemy)
    const body = document.querySelector("body[data-clp-course-id]");
    if (body) return body.getAttribute("data-clp-course-id");

    // Data attribute
    const altElement = document.querySelector("[data-course-id]");
    if (altElement) return altElement.getAttribute("data-course-id");

    // Meta tag
    const metaTag = document.querySelector('meta[property="udemy_com:course"]');
    if (metaTag) return metaTag.getAttribute("content");

    // Script content patterns
    const scripts = document.querySelectorAll('script');
    const patterns = [
      /"courseId"\s*:\s*(\d+)/,
      /"course_id"\s*:\s*(\d+)/,
      /courseId['"]\s*:\s*['"]?(\d+)/,
      /course_id['"]\s*:\s*['"]?(\d+)/,
      /"id"\s*:\s*(\d+).*?"_class"\s*:\s*"course"/,
      /"_class"\s*:\s*"course".*?"id"\s*:\s*(\d+)/
    ];
    for (const script of scripts) {
      const text = script.textContent || '';
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1];
      }
    }

    // Window.UD object
    if (window.UD && window.UD.currentCourse) {
      return String(window.UD.currentCourse.id);
    }

    // React module data
    const reactRoot = document.querySelector('[data-module-id="course-taking"]');
    if (reactRoot) {
      const dataAttr = reactRoot.getAttribute('data-module-args');
      if (dataAttr) {
        try {
          const data = JSON.parse(dataAttr);
          if (data.courseId) return String(data.courseId);
        } catch (e) {}
      }
    }

    return null;
  });
}

async function main() {
  if (process.argv.length < 3) {
    console.error('Please provide a Udemy course URL as a parameter');
    console.error('Example: npm start https://www.udemy.com/course/your-course-name');
    process.exit(1);
  }

  let courseUrl = process.argv[2];
  courseUrl = courseUrl.replace(/\/learn\/.*$/, '');
  if (!courseUrl.endsWith('/')) courseUrl += '/';

  console.log(`Course URL: ${courseUrl}`);

  const downloadSrt = await new Promise((resolve) => {
    rl.question('Download .srt files with timestamps? (yes/no) [no]: ', (answer) => {
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'yes' || normalized === 'y');
    });
  });

  const tabCount = await new Promise((resolve) => {
    rl.question('Number of parallel tabs? [5]: ', (answer) => {
      const normalized = answer.trim();
      resolve(normalized ? parseInt(normalized, 10) : 5);
    });
  });

  console.log('Launching browser...');
  const browser = await puppeteerExtra.launch({
    headless: 'new',
    defaultViewport: null,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--window-size=1280,720',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox'
    ],
    protocolTimeout: 300000
  });

  try {
    const page = await browser.newPage();
    await new Promise(resolve => setTimeout(resolve, 1000));

    const cookies = loadCookies();
    if (cookies) {
      console.log('Using cookie-based authentication...');
      await page.setCookie(...cookies);
    } else {
      await performLogin(page);
    }

    console.log(`Navigating to course page...`);
    await page.goto(courseUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    const currentUrl = page.url();
    debug(`Current URL: ${currentUrl}`);

    if (currentUrl.includes('/join/') || currentUrl.includes('/login/')) {
      if (DEBUG) {
        await page.screenshot({ path: path.join(outputDir, 'debug-login-redirect.png'), fullPage: true });
      }
      throw new Error('Authentication failed - redirected to login page. Your cookies may be expired.');
    }

    const isUdemyBusiness = !currentUrl.includes('www.udemy.com');
    if (isUdemyBusiness) console.log('Detected Udemy Business account');

    console.log('Extracting course ID...');
    let courseId = null;
    const maxWaitTime = 30000;
    const pollInterval = 500;
    let waited = 0;

    while (!courseId && waited < maxWaitTime) {
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 }).catch(() => {});
      courseId = await extractCourseId(page);

      if (!courseId) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        waited += pollInterval;
        if (waited % 10000 === 0) {
          console.log(`Still waiting for course ID... (${waited / 1000}s)`);
        }
      }
    }

    // Fallback: try API with course slug
    if (!courseId) {
      const slugMatch = currentUrl.match(/\/course\/([^/]+)/);
      if (slugMatch) {
        const courseSlug = slugMatch[1];
        debug(`Trying API with slug: ${courseSlug}`);

        const baseUrl = new URL(currentUrl).origin;
        try {
          const slugResponse = await page.evaluate(async (url) => {
            const res = await fetch(url, { credentials: 'include' });
            if (res.ok) return await res.json();
            return null;
          }, `${baseUrl}/api-2.0/courses/${courseSlug}/?fields[course]=id,title`);

          if (slugResponse && slugResponse.id) {
            courseId = String(slugResponse.id);
          }
        } catch (e) {
          debug(`Slug API failed: ${e.message}`);
        }
      }
    }

    if (!courseId) {
      if (DEBUG) {
        await page.screenshot({ path: path.join(outputDir, 'debug-no-course-id.png'), fullPage: true });
        const debugInfo = await page.evaluate(() => ({
          bodyId: document.body.id,
          bodyClass: document.body.className,
          url: window.location.href,
          title: document.title
        }));
        console.error('Debug info:', JSON.stringify(debugInfo, null, 2));
      }
      throw new Error('Could not retrieve course ID. Set DEBUG=true for more info.');
    }

    console.log(`Course ID: ${courseId}`);

    const apiBaseUrl = isUdemyBusiness ? new URL(currentUrl).origin : 'https://www.udemy.com';
    const apiUrl = `${apiBaseUrl}/api-2.0/courses/${courseId}/subscriber-curriculum-items/?page_size=200&fields%5Blecture%5D=title,object_index,is_published,sort_order,created,asset,supplementary_assets,is_free&fields%5Bquiz%5D=title,object_index,is_published,sort_order,type&fields%5Bpractice%5D=title,object_index,is_published,sort_order&fields%5Bchapter%5D=title,object_index,is_published,sort_order&fields%5Basset%5D=title,filename,asset_type,status,time_estimation,is_external,transcript,captions&caching_intent=True`;

    console.log('Fetching course content...');
    const allResults = await fetchAllPages(page, apiUrl);

    console.log('Processing course structure...');
    const courseStructure = processCourseStructure(allResults);

    console.log('Generating CONTENTS.txt...');
    generateContentsFile(courseStructure);

    console.log('Downloading transcripts...');
    await downloadTranscripts(browser, courseUrl, courseStructure, downloadSrt, tabCount);

    console.log('All transcripts downloaded successfully!');
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
    rl.close();
  }
}

async function performLogin(page) {
  console.log('Navigating to login page...');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto('https://www.udemy.com/join/passwordless-auth', { waitUntil: 'domcontentloaded' });
      break;
    } catch (err) {
      if (err.message.includes('frame was detached') && attempt < 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        throw err;
      }
    }
  }

  if (!process.env.UDEMY_EMAIL) {
    console.error('UDEMY_EMAIL not found in .env file.');
    process.exit(1);
  }

  console.log('Processing login...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  await page.waitForSelector('input[name="email"]');
  await page.type('input[name="email"]', process.env.UDEMY_EMAIL, { delay: 100 });

  try {
    const cookieButton = await page.$('#onetrust-accept-btn-handler');
    if (cookieButton) await cookieButton.click();
  } catch (e) {}

  await page.$eval('[data-purpose="code-generation-form"] [type="submit"]', el => el.click());
  console.log('Email submitted, check your inbox for verification code.');

  const verificationCode = await new Promise((resolve) => {
    rl.question('Enter 6-digit verification code: ', (code) => resolve(code.trim()));
  });

  await page.waitForSelector('[data-purpose="otp-text-area"] input', { timeout: 60000 });
  await page.type('[data-purpose="otp-text-area"] input', verificationCode, { delay: 100 });
  await page.$eval('[data-purpose="otp-verification-form"] [type="submit"]', el => el.click());

  await new Promise(resolve => setTimeout(resolve, 5000));
  console.log('Login successful!');
}

async function fetchAllPages(page, url) {
  const results = [];
  let nextUrl = url;
  let pageNum = 1;

  while (nextUrl) {
    let pageJson = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(nextUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 2000));

        const rawBody = await page.evaluate(() => document.body.innerText);
        if (rawBody.trim().startsWith('<!DOCTYPE html>')) {
          throw new Error('HTML response instead of JSON');
        }

        pageJson = JSON.parse(rawBody);
        if (pageJson?.results) break;
        throw new Error('No results in response');
      } catch (err) {
        console.warn(`Page ${pageNum}, attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          throw new Error('Could not retrieve course content.');
        }
      }
    }

    results.push(...pageJson.results);
    debug(`Fetched page ${pageNum} (${pageJson.results.length} items, total: ${results.length})`);

    nextUrl = pageJson.next || null;
    pageNum++;
  }

  console.log(`Fetched ${results.length} items across ${pageNum - 1} page(s).`);
  return results;
}

function processCourseStructure(results) {
  const courseStructure = { chapters: [], lectures: [] };
  const sortedResults = [...results].sort((a, b) => b.sort_order - a.sort_order);

  let currentChapter = null;
  let chapterCounter = 1;
  let lectureCounter = 1;

  sortedResults.forEach(item => {
    if (item._class === 'chapter') {
      currentChapter = {
        id: item.id,
        title: item.title,
        index: chapterCounter++,
        lectures: []
      };
      courseStructure.chapters.push(currentChapter);
      lectureCounter = 1;
    } else if (
      item._class === 'lecture' &&
      item.asset?.asset_type?.toLowerCase().includes('video')
    ) {
      const lecture = {
        id: item.id,
        title: item.title,
        created: item.created,
        timeEstimation: item.asset.time_estimation,
        chapterIndex: currentChapter?.index || null,
        lectureIndex: lectureCounter++,
        captions: item.asset.captions?.filter(c => c.url) || []
      };

      if (currentChapter) {
        currentChapter.lectures.push(lecture);
      } else {
        courseStructure.lectures.push(lecture);
      }
    }
  });

  return courseStructure;
}

function normalizeTimestamp(ts) {
  const [main, ms] = ts.split('.');
  const parts = main.split(':');
  while (parts.length < 3) parts.unshift('00');
  return `${parts.map(p => p.padStart(2, '0')).join(':')},${(ms || '000').padEnd(3, '0')}`;
}

function convertVttToSrt(vtt) {
  return vtt
    .replace(/^WEBVTT(\n|\r|\r\n)?/, '')
    .trim()
    .split(/\n{2,}/)
    .map((block, i) => {
      const lines = block.trim().split('\n');
      if (lines.length < 2) return null;
      const [startEnd, ...textLines] = lines;
      const [start, end] = startEnd.split(' --> ').map(normalizeTimestamp);
      return `${i + 1}\n${start} --> ${end}\n${textLines.join('\n')}\n`;
    })
    .filter(Boolean)
    .join('\n');
}

function generateContentsFile(courseStructure) {
  let content = '';

  for (const chapter of courseStructure.chapters) {
    content += `${chapter.index}. ${chapter.title}\n`;
    for (const lecture of chapter.lectures) {
      const mins = Math.floor(lecture.timeEstimation / 60);
      const date = new Date(lecture.created).toLocaleDateString();
      content += `${chapter.index}.${lecture.lectureIndex} ${lecture.title} [${mins} min, ${date}]\n`;
    }
    content += '\n';
  }

  for (const lecture of courseStructure.lectures) {
    const mins = Math.floor(lecture.timeEstimation / 60);
    const date = new Date(lecture.created).toLocaleDateString();
    content += `${lecture.lectureIndex}. ${lecture.title} [${mins} min, ${date}]\n`;
  }

  fs.writeFileSync(path.join(outputDir, 'CONTENTS.txt'), content, 'utf8');
  console.log('CONTENTS.txt created.');
}

async function downloadTranscripts(browser, courseUrl, courseStructure, downloadSrt, tabCount = 5) {
  const allLectures = [];

  for (const chapter of courseStructure.chapters) {
    for (const lecture of chapter.lectures) {
      allLectures.push({ lecture, chapter });
    }
  }
  for (const lecture of courseStructure.lectures) {
    allLectures.push({ lecture, chapter: null });
  }

  const chunks = Array.from({ length: tabCount }, () => []);
  allLectures.forEach((item, i) => chunks[i % tabCount].push(item));

  await Promise.all(chunks.map(async (chunk, tabIndex) => {
    const page = await browser.newPage();
    console.log(`Tab ${tabIndex + 1}: processing ${chunk.length} lectures`);

    for (const { lecture, chapter } of chunk) {
      await processLecture(page, courseUrl, lecture, chapter, downloadSrt);
    }

    await page.close();
  }));
}

async function processLecture(page, courseUrl, lecture, chapter = null, downloadSrt = false) {
  const baseUrl = courseUrl.endsWith('/') ? courseUrl.slice(0, -1) : courseUrl;
  const lectureUrl = `${baseUrl}/learn/lecture/${lecture.id}`;
  const filename = chapter
    ? `${chapter.index}.${lecture.lectureIndex} ${lecture.title}`
    : `${lecture.lectureIndex}. ${lecture.title}`;
  const sanitizedFilename = filename.replace(/[/\\?%*:|"<>]/g, '-');

  console.log(`Processing: ${sanitizedFilename}`);

  try {
    await page.goto(lectureUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('video', { timeout: 30000, visible: true }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 2000));

    const transcriptSelectors = [
      'button[data-purpose="transcript-toggle"]',
      '[data-purpose="transcript-toggle"]',
      '[aria-label*="transcript" i]',
      'button[aria-label*="transcript" i]'
    ];

    let panelOpened = false;
    for (const selector of transcriptSelectors) {
      const exists = await page.$(selector);
      if (exists) {
        await page.$eval(selector, el => el.click());
        await new Promise(resolve => setTimeout(resolve, 1500));

        panelOpened = await page.evaluate(() => {
          const panel = document.querySelector('[data-purpose="transcript-panel"]');
          return panel && panel.offsetParent !== null;
        });

        if (panelOpened) break;
      }
    }

    if (!panelOpened) {
      fs.writeFileSync(
        path.join(outputDir, `${sanitizedFilename}.txt`),
        `# ${sanitizedFilename}\n\n[No transcript available]`,
        'utf8'
      );
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    let transcriptText = '';
    for (let i = 0; i < 3; i++) {
      transcriptText = await page.evaluate(() => {
        const panel = document.querySelector('[data-purpose="transcript-panel"]');
        return panel?.textContent || '';
      });
      if (transcriptText.trim()) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!transcriptText.trim()) {
      console.log(`No transcript content for: ${lecture.title}`);
      return;
    }

    fs.writeFileSync(
      path.join(outputDir, `${sanitizedFilename}.txt`),
      `# ${sanitizedFilename}\n\n${transcriptText}`,
      'utf8'
    );

    if (downloadSrt && lecture.captions?.length > 0) {
      for (const caption of lecture.captions) {
        try {
          const vttContent = await page.evaluate(async (url) => {
            const res = await fetch(url);
            return await res.text();
          }, caption.url);

          const srtContent = convertVttToSrt(vttContent);
          const langTag = caption.locale_id || 'unknown';
          fs.writeFileSync(
            path.join(outputDir, `${sanitizedFilename} [${langTag}].srt`),
            srtContent,
            'utf8'
          );
        } catch (err) {
          debug(`SRT error for ${sanitizedFilename}: ${err.message}`);
        }
      }
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error) {
    console.error(`Error processing ${lecture.title}: ${error.message}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
