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
      // If it's an object with named cookie entries (e.g., {statsAuth: {value: "...", ...}})
      // Each key is the cookie name, and the value object contains 'value' property
      const cookieParts = [];
      for (const [name, data] of Object.entries(cookies)) {
        if (data && typeof data === 'object' && data.value) {
          cookieParts.push(`${name}=${data.value}`);
        }
      }
      if (cookieParts.length > 0) {
        return cookieParts.join('; ');
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
 * Extract subpage links from a main AWStats HTML page.
 * Returns relative filenames like "awstats.domain.urldetail.html".
 */
function extractSubpageLinks(html) {
  const $ = cheerio.load(html);
  const subpages = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    // Skip anchor links
    if (href.startsWith('#')) return;
    // Skip external links (e.g. awstats.org)
    if (href.startsWith('http://') || href.startsWith('https://')) return;
    // Only include awstats .html subpage files
    if (href.startsWith('awstats.') && href.endsWith('.html')) {
      subpages.add(href);
    }
  });

  return Array.from(subpages);
}

/**
 * Download resources for an HTML page and save the rewritten HTML.
 * Reuses existing resources in the resources/ folder if already downloaded.
 */
async function downloadResourcesAndSave(html, pageUrl, pageDir, htmlFilename, cookies) {
  const resourceDir = path.join(pageDir, 'resources');
  await fs.ensureDir(resourceDir);

  const resources = extractResources(html, pageUrl);
  const resourceMap = {};

  for (const resource of resources) {
    try {
      const filename = urlToFilename(resource.url);
      const localPath = `resources/${filename}`;
      const fullPath = path.join(pageDir, localPath);

      // Skip if resource already exists on disk
      if (await fs.pathExists(fullPath)) {
        resourceMap[resource.original] = localPath;
        resourceMap[resource.url] = localPath;
        continue;
      }

      const resResponse = await fetchWithAuth(resource.url, cookies);
      const buffer = Buffer.from(await resResponse.arrayBuffer());
      await fs.writeFile(fullPath, buffer);

      resourceMap[resource.original] = localPath;
      resourceMap[resource.url] = localPath;

      console.log(`    + ${resource.type}: ${filename}`);
    } catch (err) {
      console.log(`    ! Failed to fetch ${resource.url}: ${err.message}`);
    }
  }

  html = rewriteHtmlUrls(html, resourceMap, pageUrl);
  await fs.writeFile(path.join(pageDir, htmlFilename), html);

  return resources.length;
}

/**
 * Fetch and save a single statistics page with all its resources
 */
async function fetchPage(url, domain, dateCode, cookies) {
  const domainDir = path.join(OUTPUT_DIR, domain);
  const pageDir = path.join(domainDir, dateCode);

  await fs.ensureDir(pageDir);

  console.log(`  Fetching: ${url}`);

  // Fetch the main HTML page
  const response = await fetchWithAuth(url, cookies);
  let html = await response.text();

  const htmlFilename = path.basename(new URL(url).pathname) || 'index.html';
  const resourceCount = await downloadResourcesAndSave(html, url, pageDir, htmlFilename, cookies);

  return { success: true, resources: resourceCount };
}

/**
 * Fetch subpages for a main page that has already been fetched.
 * Reads the saved main page HTML to discover subpage links, then fetches each one.
 */
async function fetchSubpages(url, domain, dateCode, cookies) {
  const domainDir = path.join(OUTPUT_DIR, domain);
  const pageDir = path.join(domainDir, dateCode);

  const mainHtmlFilename = path.basename(new URL(url).pathname) || 'index.html';
  const mainHtmlPath = path.join(pageDir, mainHtmlFilename);

  if (!(await fs.pathExists(mainHtmlPath))) {
    console.log(`  Skipping subpages for ${url} (main page not found on disk)`);
    return { subpagesFetched: 0, subpagesFailed: 0 };
  }

  const mainHtml = await fs.readFile(mainHtmlPath, 'utf-8');
  const subpageLinks = extractSubpageLinks(mainHtml);

  // Filter out the main page itself
  const filteredLinks = subpageLinks.filter((link) => link !== mainHtmlFilename);

  if (filteredLinks.length === 0) {
    return { subpagesFetched: 0, subpagesFailed: 0 };
  }

  console.log(`  Found ${filteredLinks.length} subpages for ${dateCode}`);

  const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
  let subpagesFetched = 0;
  let subpagesFailed = 0;

  for (const subpageFile of filteredLinks) {
    const subpageUrl = baseUrl + subpageFile;
    const subpagePath = path.join(pageDir, subpageFile);

    // Skip if subpage already exists
    if (await fs.pathExists(subpagePath)) {
      console.log(`    Already fetched: ${subpageFile}`);
      subpagesFetched++;
      continue;
    }

    try {
      console.log(`    Fetching subpage: ${subpageFile}`);
      const response = await fetchWithAuth(subpageUrl, cookies);
      let html = await response.text();

      await downloadResourcesAndSave(html, subpageUrl, pageDir, subpageFile, cookies);
      subpagesFetched++;

      // Small delay between subpage requests
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch (err) {
      console.log(`    ! Failed to fetch subpage ${subpageFile}: ${err.message}`);
      subpagesFailed++;
    }
  }

  return { subpagesFetched, subpagesFailed };
}

/**
 * Main function to fetch all statistics pages
 */
async function main() {
  const subpagesOnly = process.argv.includes('--subpages-only');

  console.log('Domeneshop Statistics Fetcher\n');
  if (subpagesOnly) {
    console.log('Mode: subpages only (main pages already fetched)\n');
  }

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

  let processed = 0;
  let failed = 0;
  let totalSubpagesFetched = 0;
  let totalSubpagesFailed = 0;

  for (const [domain, entries] of Object.entries(domains)) {
    console.log(`\n[${domain}] (${entries.length} pages)`);

    for (const entry of entries) {
      try {
        if (!subpagesOnly) {
          await fetchPage(entry.url, domain, entry.dateCode, cookies);
        }

        // Fetch subpages
        const { subpagesFetched, subpagesFailed } = await fetchSubpages(
          entry.url, domain, entry.dateCode, cookies
        );
        totalSubpagesFetched += subpagesFetched;
        totalSubpagesFailed += subpagesFailed;

        processed++;
      } catch (err) {
        console.error(`  ERROR: ${entry.url} - ${err.message}`);
        failed++;
      }

      // Small delay to be nice to the server
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  console.log(`\n\nDone!`);
  console.log(`Main pages: ${processed} processed, ${failed} failed.`);
  console.log(`Subpages: ${totalSubpagesFetched} fetched, ${totalSubpagesFailed} failed.`);
  console.log(`Output saved to: ${OUTPUT_DIR}`);
}

main().catch(console.error);
