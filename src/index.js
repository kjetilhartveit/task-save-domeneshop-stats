import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseStatisticsHtml } from './parse-urls.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const OUTPUT_DIR = path.join(projectRoot, 'output');
const COOKIES_FILE = path.join(projectRoot, 'cookies.json');

/**
 * Load cookies from cookies.json file
 */
async function loadCookies() {
  try {
    if (await fs.pathExists(COOKIES_FILE)) {
      const cookies = await fs.readJson(COOKIES_FILE);
      // Convert array of cookie objects to cookie header string
      if (Array.isArray(cookies)) {
        return cookies
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');
      }
      // If it's already a string, return as-is
      if (typeof cookies === 'string') {
        return cookies;
      }
      // If it's an object with a 'cookies' key
      if (cookies.cookies) {
        return cookies.cookies;
      }
    }
  } catch (err) {
    console.error('Error loading cookies:', err.message);
  }
  return null;
}

/**
 * Fetch a URL with authentication
 */
async function fetchWithAuth(url, cookies) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  if (cookies) {
    headers['Cookie'] = cookies;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response;
}

/**
 * Extract resources (CSS, JS, images) from HTML
 */
function extractResources(html, baseUrl) {
  const $ = cheerio.load(html);
  const resources = new Set();
  const base = new URL(baseUrl);

  // CSS files
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      try {
        const absoluteUrl = new URL(href, base).href;
        resources.add({ type: 'css', url: absoluteUrl, original: href });
      } catch {
        // Invalid URL, skip
      }
    }
  });

  // JavaScript files
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) {
      try {
        const absoluteUrl = new URL(src, base).href;
        resources.add({ type: 'js', url: absoluteUrl, original: src });
      } catch {
        // Invalid URL, skip
      }
    }
  });

  // Images
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) {
      try {
        const absoluteUrl = new URL(src, base).href;
        resources.add({ type: 'image', url: absoluteUrl, original: src });
      } catch {
        // Invalid URL, skip
      }
    }
  });

  // Background images in style attributes
  $('[style*="url("]').each((_, el) => {
    const style = $(el).attr('style');
    const urlMatch = style.match(/url\(['"]?([^'")\s]+)['"]?\)/gi);
    if (urlMatch) {
      urlMatch.forEach((match) => {
        const urlPart = match.match(/url\(['"]?([^'")\s]+)['"]?\)/i);
        if (urlPart && urlPart[1]) {
          try {
            const absoluteUrl = new URL(urlPart[1], base).href;
            resources.add({ type: 'image', url: absoluteUrl, original: urlPart[1] });
          } catch {
            // Invalid URL, skip
          }
        }
      });
    }
  });

  return Array.from(resources);
}

/**
 * Generate a safe filename from URL
 */
function urlToFilename(url) {
  const parsed = new URL(url);
  let pathname = parsed.pathname;

  // Remove leading slash
  if (pathname.startsWith('/')) {
    pathname = pathname.substring(1);
  }

  // Replace remaining slashes with underscores
  pathname = pathname.replace(/\//g, '_');

  // Add query string hash if present
  if (parsed.search) {
    const hash = Buffer.from(parsed.search).toString('base64').substring(0, 8);
    const ext = path.extname(pathname);
    const base = path.basename(pathname, ext);
    pathname = `${base}_${hash}${ext}`;
  }

  return pathname || 'index.html';
}

/**
 * Rewrite resource URLs in HTML to point to local files
 */
function rewriteHtmlUrls(html, resourceMap, baseUrl) {
  let rewritten = html;

  for (const [originalUrl, localPath] of Object.entries(resourceMap)) {
    // Escape special regex characters in the URL
    const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'g');
    rewritten = rewritten.replace(regex, localPath);
  }

  return rewritten;
}

/**
 * Fetch and save a single statistics page with all its resources
 */
async function fetchPage(url, domain, dateCode, cookies) {
  const domainDir = path.join(OUTPUT_DIR, domain);
  const pageDir = path.join(domainDir, dateCode);
  const resourceDir = path.join(pageDir, 'resources');

  await fs.ensureDir(pageDir);
  await fs.ensureDir(resourceDir);

  console.log(`  Fetching: ${url}`);

  // Fetch the main HTML page
  const response = await fetchWithAuth(url, cookies);
  let html = await response.text();

  // Extract and download resources
  const resources = extractResources(html, url);
  const resourceMap = {};

  for (const resource of resources) {
    try {
      const filename = urlToFilename(resource.url);
      const localPath = `resources/${filename}`;
      const fullPath = path.join(pageDir, localPath);

      // Download the resource
      const resResponse = await fetchWithAuth(resource.url, cookies);
      const buffer = Buffer.from(await resResponse.arrayBuffer());
      await fs.writeFile(fullPath, buffer);

      // Map original URL to local path
      resourceMap[resource.original] = localPath;
      resourceMap[resource.url] = localPath;

      console.log(`    + ${resource.type}: ${filename}`);
    } catch (err) {
      console.log(`    ! Failed to fetch ${resource.url}: ${err.message}`);
    }
  }

  // Rewrite HTML to use local resources
  html = rewriteHtmlUrls(html, resourceMap, url);

  // Save the HTML file
  const htmlFilename = path.basename(new URL(url).pathname) || 'index.html';
  await fs.writeFile(path.join(pageDir, htmlFilename), html);

  return { success: true, resources: resources.length };
}

/**
 * Main function to fetch all statistics pages
 */
async function main() {
  console.log('Domeneshop Statistics Fetcher\n');

  // Load cookies
  const cookies = await loadCookies();
  if (!cookies) {
    console.error('ERROR: No cookies found. Please create a cookies.json file.');
    console.error('\nTo get cookies:');
    console.error('1. Log in to stat.domeneshop.no in your browser');
    console.error('2. Open browser DevTools (F12) -> Network tab');
    console.error('3. Refresh the page and click on any request');
    console.error('4. Copy the Cookie header value');
    console.error('5. Create cookies.json with: {"cookies": "your_cookie_string_here"}');
    console.error('\nOr use a browser extension like "EditThisCookie" to export cookies as JSON.');
    process.exit(1);
  }

  console.log('Cookies loaded successfully.\n');

  // Parse URLs from HTML
  const domains = await parseStatisticsHtml();
  const totalUrls = Object.values(domains).reduce((sum, entries) => sum + entries.length, 0);

  console.log(`Found ${totalUrls} pages across ${Object.keys(domains).length} domains.\n`);

  // Ensure output directory exists
  await fs.ensureDir(OUTPUT_DIR);

  // Fetch all pages
  let processed = 0;
  let failed = 0;

  for (const [domain, entries] of Object.entries(domains)) {
    console.log(`\n[${domain}] (${entries.length} pages)`);

    for (const entry of entries) {
      try {
        await fetchPage(entry.url, domain, entry.dateCode, cookies);
        processed++;
      } catch (err) {
        console.error(`  ERROR: ${entry.url} - ${err.message}`);
        failed++;
      }

      // Small delay to be nice to the server
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  console.log(`\n\nDone! Processed ${processed} pages, ${failed} failed.`);
  console.log(`Output saved to: ${OUTPUT_DIR}`);
}

main().catch(console.error);
