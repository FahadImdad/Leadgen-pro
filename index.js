#!/usr/bin/env node

/**
 * Lead Extractor - Main Entry Point
 * 
 * Usage:
 *   node index.js --keywords "book publishing,web development" --platforms "google,upwork" --max 100
 *   
 * Or with npm:
 *   npm start -- --keywords "book publishing" --max 50
 */

require('dotenv').config();
const LeadExtractor = require('./src/LeadExtractor');
const keywords = require('./config/keywords.json');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    keywords: keywords.services.slice(0, 3), // Default: first 3 keywords
    platforms: ['google'], // Default: just google (free tier friendly)
    maxPerPlatform: 50,
    region: 'us'
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--keywords':
      case '-k':
        options.keywords = args[++i].split(',').map(k => k.trim());
        break;
      case '--platforms':
      case '-p':
        options.platforms = args[++i].split(',').map(p => p.trim().toLowerCase());
        break;
      case '--max':
      case '-m':
        options.maxPerPlatform = parseInt(args[++i], 10);
        break;
      case '--region':
      case '-r':
        options.region = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
Lead Extractor - Extract leads from multiple platforms

Usage:
  node index.js [options]

Options:
  -k, --keywords   Comma-separated keywords (default: from config)
  -p, --platforms  Platforms to search: google,upwork,reddit (default: google)
  -m, --max        Max results per platform (default: 50)
  -r, --region     Region code: us,uk,ca,au (default: us)
  -h, --help       Show this help

Examples:
  node index.js --keywords "book publishing" --platforms "google" --max 20
  node index.js -k "web developer needed" -p "google,upwork,reddit" -m 100

API Keys (set in .env file):
  APIFY_API_TOKEN   - For Upwork, Reddit scraping
  SERPAPI_KEY       - For Google search
  HUNTER_API_KEY    - For email finding/verification
        `);
        process.exit(0);
    }
  }

  return options;
}

async function main() {
  console.log('\n🔍 Lead Extractor v1.0\n');

  // Check for API keys
  const hasApify = !!process.env.APIFY_API_TOKEN;
  const hasSerpApi = !!process.env.SERPAPI_KEY;
  const hasHunter = !!process.env.HUNTER_API_KEY;

  console.log('API Status:');
  console.log(`  Apify:   ${hasApify ? '✅ Configured' : '❌ Not set (Upwork/Reddit disabled)'}`);
  console.log(`  SerpAPI: ${hasSerpApi ? '✅ Configured' : '❌ Not set (Google search disabled)'}`);
  console.log(`  Hunter:  ${hasHunter ? '✅ Configured' : '❌ Not set (Email enrichment disabled)'}`);
  console.log('');

  if (!hasApify && !hasSerpApi) {
    console.error('❌ Error: At least one API key required (APIFY_API_TOKEN or SERPAPI_KEY)');
    console.log('\nSetup instructions:');
    console.log('1. Copy .env.example to .env');
    console.log('2. Add your API keys');
    console.log('3. Run again\n');
    process.exit(1);
  }

  const options = parseArgs();
  
  // Filter platforms based on available API keys
  if (!hasSerpApi) {
    options.platforms = options.platforms.filter(p => p !== 'google');
  }
  if (!hasApify) {
    options.platforms = options.platforms.filter(p => !['upwork', 'reddit', 'thumbtack'].includes(p));
  }

  if (options.platforms.length === 0) {
    console.error('❌ No platforms available with current API keys');
    process.exit(1);
  }

  console.log('Configuration:');
  console.log(`  Keywords:  ${options.keywords.join(', ')}`);
  console.log(`  Platforms: ${options.platforms.join(', ')}`);
  console.log(`  Max/Platform: ${options.maxPerPlatform}`);
  console.log(`  Region: ${options.region.toUpperCase()}`);
  console.log('');

  // Initialize extractor
  const extractor = new LeadExtractor({
    apifyToken: process.env.APIFY_API_TOKEN,
    serpApiKey: process.env.SERPAPI_KEY,
    hunterApiKey: process.env.HUNTER_API_KEY
  });

  // Run extraction
  const leads = await extractor.extract(options);

  if (leads.length === 0) {
    console.log('\n⚠️  No leads found. Try different keywords or platforms.\n');
    return;
  }

  // Export results
  const timestamp = new Date().toISOString().split('T')[0];
  const excelPath = extractor.exportToExcel(`leads_${timestamp}.xlsx`);
  const jsonPath = extractor.exportToJSON(`leads_${timestamp}.json`);

  console.log('\n✅ Extraction Complete!');
  console.log(`   Total leads: ${leads.length}`);
  console.log(`   Excel: ${excelPath}`);
  console.log(`   JSON: ${jsonPath}`);
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
