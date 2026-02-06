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
 * Map URL path domain segment to output folder name.
 * The "all" domain in URLs corresponds to the "All domains" output folder.
 */
function urlPathToFolderName(urlPath) {
  if (urlPath === 'all') return 'All domains';
  return urlPath;
}

/**
 * Fetch the overview page and save it as a static index.html in the output root.
 * Uses the pre-rendered HTML from "Webpage statistics.html" as the base (since
 * the live page is a React SPA that requires JS to render), downloads the CSS
 * and logo from the server, rewrites links to point to local files, and removes
 * unnecessary elements like the logout button and JS bundle.
 */
async function fetchOverview(cookies) {
  console.log('Fetching overview page resources...\n');

  // Fetch the live page to discover actual resource URLs
  const overviewUrl = 'https://stat.domeneshop.no/';
  const response = await fetchWithAuth(overviewUrl, cookies);
  const liveHtml = await response.text();

  // Read the pre-rendered saved HTML (has full DOM content)
  const savedHtmlPath = path.join(projectRoot, 'Webpage statistics.html');
  const savedHtml = await fs.readFile(savedHtmlPath, 'utf-8');
  const $ = cheerio.load(savedHtml);

  // Extract actual resource URLs from the live page
  const $live = cheerio.load(liveHtml);
  const cssHref = $live('link[rel="stylesheet"]').attr('href');

  // Remove the JS script tag (content is already rendered, JS would interfere)
  $('script').remove();

  // Remove the logout button (not useful for static page)
  $('.logoutButton').remove();

  // Remove noscript message (not relevant for static page)
  $('noscript').remove();

  // Rewrite stat links to local relative paths
  $('a[href*="stat.domeneshop.no/data/"]').each((_, el) => {
    const href = $(el).attr('href');
    const match = href.match(/stat\.domeneshop\.no\/data\/([^/]+)\/(\d{6})\/(.+\.html)/);
    if (match) {
      const [, urlDomain, dateCode, filename] = match;
      const folderName = urlPathToFolderName(urlDomain);
      const localPath = `./${folderName}/${dateCode}/${filename}`;
      $(el).attr('href', localPath);
      $(el).removeAttr('target');
      $(el).removeAttr('rel');
    }
  });

  // Download resources (CSS, logo) from the server
  const resourceDir = path.join(OUTPUT_DIR, 'resources');
  await fs.ensureDir(resourceDir);

  // Download CSS
  if (cssHref) {
    try {
      const cssUrl = new URL(cssHref, overviewUrl).href;
      const cssFilename = urlToFilename(cssUrl);
      const cssLocalPath = `resources/${cssFilename}`;
      const cssFullPath = path.join(OUTPUT_DIR, cssLocalPath);

      if (!(await fs.pathExists(cssFullPath))) {
        const cssResponse = await fetchWithAuth(cssUrl, cookies);
        const cssBuffer = Buffer.from(await cssResponse.arrayBuffer());
        await fs.writeFile(cssFullPath, cssBuffer);
        console.log(`  + css: ${cssFilename}`);
      }

      $('link[rel="stylesheet"]').attr('href', cssLocalPath);
    } catch (err) {
      console.log(`  ! Failed to fetch CSS: ${err.message}`);
    }
  }

  // Download logo - extract the actual URL from the JS bundle
  // In CRA builds, the logo is imported in JS and gets a hashed path like /static/media/logo-no.{hash}.svg
  const jsSrc = $live('script[src]').attr('src');
  let logoLocalPath = null;
  if (jsSrc) {
    try {
      const jsUrl = new URL(jsSrc, overviewUrl).href;
      const jsResponse = await fetchWithAuth(jsUrl, cookies);
      const jsContent = await jsResponse.text();

      // Look for logo references in the JS bundle (e.g., "/images/logo-no.svg")
      const logoMatch = jsContent.match(/"(\/[^"]*logo[^"]*\.svg)"/i);
      if (logoMatch) {
        const logoPath = logoMatch[1];
        const logoUrl = new URL(logoPath, overviewUrl).href;
        const logoFilename = urlToFilename(logoUrl);
        logoLocalPath = `resources/${logoFilename}`;
        const logoFullPath = path.join(OUTPUT_DIR, logoLocalPath);

        if (!(await fs.pathExists(logoFullPath))) {
          const logoResponse = await fetchWithAuth(logoUrl, cookies);
          const logoBuffer = Buffer.from(await logoResponse.arrayBuffer());
          await fs.writeFile(logoFullPath, logoBuffer);
          console.log(`  + image: ${logoFilename}`);
        }
      } else {
        console.log('  ! Could not find logo URL in JS bundle');
      }
    } catch (err) {
      console.log(`  ! Failed to extract/fetch logo: ${err.message}`);
    }
  }

  if (logoLocalPath) {
    $('img.headerLogo').attr('src', logoLocalPath);
  }

  const finalHtml = $.html();
  const indexPath = path.join(OUTPUT_DIR, 'index.html');
  await fs.writeFile(indexPath, finalHtml);

  console.log(`\nOverview page saved to: ${indexPath}`);
}

/**
 * Main function to fetch all statistics pages
 */
async function main() {
  const subpagesOnly = process.argv.includes('--subpages-only');
  const overviewOnly = process.argv.includes('--overview');

  console.log('Domeneshop Statistics Fetcher\n');
  if (subpagesOnly) {
    console.log('Mode: subpages only (main pages already fetched)\n');
  }
  if (overviewOnly) {
    console.log('Mode: overview page only\n');
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

  // Handle overview-only mode
  if (overviewOnly) {
    await fetchOverview(cookies);
    return;
  }

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
