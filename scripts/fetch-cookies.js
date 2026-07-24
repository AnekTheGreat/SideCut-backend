#!/usr/bin/env node
/**
 * Cookie Fetcher Script
 * 
 * This script fetches fresh YouTube cookies from a browser session.
 * Can be run on a schedule (cron job) to keep cookies fresh.
 * 
 * Usage:
 *   node scripts/fetch-cookies.js --url https://example.com/cookies --output /tmp/cookies.txt
 * 
 * Environment Variables:
 *   COOKIE_PROVIDER_URL - URL to fetch cookies from
 *   COOKIE_PROVIDER_KEY - API key for the provider
 * 
 * Options:
 *   --url      - URL to fetch cookies from
 *   --output   - Output file path (default: /tmp/yt_cookies.txt)
 *   --key      - API key for the provider
 *   --print    - Print cookies to stdout instead of file
 */

const fs = require('fs');
const https = require('https');
const http = require('http');
const { parseArgs } = require('util');

// Parse command line args
const { values } = parseArgs({
  options: {
    url: { type: 'string', short: 'u' },
    output: { type: 'string', short: 'o', default: '/tmp/yt_cookies.txt' },
    key: { type: 'string', short: 'k' },
    print: { type: 'boolean', short: 'p', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  },
  allowPositionals: true
});

if (values.help) {
  console.log(`
Cookie Fetcher Script
=====================

Fetches fresh YouTube cookies from a provider URL.

Usage:
  node scripts/fetch-cookies.js [options]

Options:
  -u, --url <url>      URL to fetch cookies from
  -o, --output <file>  Output file path (default: /tmp/yt_cookies.txt)
  -k, --key <key>      API key for the provider
  -p, --print          Print cookies to stdout instead of file
  -h, --help           Show this help message

Environment Variables:
  COOKIE_PROVIDER_URL   URL to fetch cookies from
  COOKIE_PROVIDER_KEY   API key for the provider

Example:
  node scripts/fetch-cookies.js --url https://my-cookie-service.com/youtube --key my-api-key
`);
  process.exit(0);
}

// Get config from args or environment
const url = values.url || process.env.COOKIE_PROVIDER_URL;
const apiKey = values.key || process.env.COOKIE_PROVIDER_KEY;

if (!url) {
  console.error('Error: No URL provided. Use --url or set COOKIE_PROVIDER_URL');
  process.exit(1);
}

async function fetchCookies() {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SideCut-CookieFetcher/1.0'
      }
    };

    if (apiKey) {
      options.headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const protocol = parsed.protocol === 'https:' ? https : http;
    
    const req = protocol.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        
        try {
          const json = JSON.parse(data);
          const cookies = json.cookies || json.cookie || json;
          resolve(cookies);
        } catch (e) {
          // Maybe it's already in cookie format
          resolve(data);
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.end();
  });
}

async function main() {
  try {
    console.log(`Fetching cookies from: ${url}`);
    const cookies = await fetchCookies();
    
    if (values.print) {
      console.log(cookies);
    } else {
      fs.writeFileSync(values.output, cookies);
      console.log(`Cookies saved to: ${values.output}`);
    }
    
    console.log('Done!');
    process.exit(0);
  } catch (error) {
    console.error('Error fetching cookies:', error.message);
    process.exit(1);
  }
}

main();
