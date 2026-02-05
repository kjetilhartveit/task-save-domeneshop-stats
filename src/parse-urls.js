import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

/**
 * Parse the HTML file and extract all statistics URLs grouped by domain
 * @returns {Object} Object with domain names as keys and arrays of URL info as values
 */
export async function parseStatisticsHtml() {
  const htmlPath = path.join(projectRoot, 'Webpage statistics.html');
  const html = await fs.readFile(htmlPath, 'utf-8');
  const $ = cheerio.load(html);

  const domains = {};

  // Find all domain sections
  $('.tree > ul > li').each((_, domainLi) => {
    const domainName = $(domainLi).find('> .domain').text().trim();

    if (!domainName) return;

    domains[domainName] = [];

    // Find all links within this domain section
    $(domainLi).find('ul > li > a').each((_, link) => {
      const href = $(link).attr('href');
      const text = $(link).text().trim();

      if (href && href.includes('stat.domeneshop.no')) {
        // Extract date from URL (format: YYYYMM)
        const dateMatch = href.match(/\/(\d{6})\//);
        const dateCode = dateMatch ? dateMatch[1] : null;

        domains[domainName].push({
          url: href,
          label: text,
          dateCode,
        });
      }
    });
  });

  return domains;
}

/**
 * Get a flat list of all URLs with their domain info
 */
export async function getAllUrls() {
  const domains = await parseStatisticsHtml();
  const urls = [];

  for (const [domain, entries] of Object.entries(domains)) {
    for (const entry of entries) {
      urls.push({
        domain,
        ...entry,
      });
    }
  }

  return urls;
}

// Run if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const domains = await parseStatisticsHtml();

  console.log('Parsed statistics URLs:\n');

  let totalUrls = 0;
  for (const [domain, entries] of Object.entries(domains)) {
    console.log(`\n${domain} (${entries.length} entries):`);
    for (const entry of entries) {
      console.log(`  - ${entry.label}: ${entry.url}`);
      totalUrls++;
    }
  }

  console.log(`\n\nTotal: ${totalUrls} URLs across ${Object.keys(domains).length} domains`);
}
