/**
 * Lead Extractor - Main Class
 * Extracts leads from multiple platforms
 */

const { ApifyClient } = require('apify-client');
const { getJson } = require('serpapi');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class LeadExtractor {
  constructor(config) {
    this.apifyToken = config.apifyToken;
    this.serpApiKey = config.serpApiKey;
    this.hunterApiKey = config.hunterApiKey;
    
    if (this.apifyToken) {
      this.apifyClient = new ApifyClient({ token: this.apifyToken });
    }
    
    this.leads = [];
    this.seenEmails = new Set();
    this.dbPath = path.join(__dirname, '../data/seen_leads.json');
    this.loadSeenLeads();
  }

  // Load previously seen leads for deduplication
  loadSeenLeads() {
    try {
      const dataDir = path.join(__dirname, '../data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      if (fs.existsSync(this.dbPath)) {
        const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
        this.seenEmails = new Set(data.emails || []);
        console.log(`Loaded ${this.seenEmails.size} previously seen emails`);
      }
    } catch (err) {
      console.log('No previous leads database found, starting fresh');
      this.seenEmails = new Set();
    }
  }

  // Save seen leads for future deduplication
  saveSeenLeads() {
    const data = { 
      emails: Array.from(this.seenEmails),
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2));
    console.log(`Saved ${this.seenEmails.size} emails to database`);
  }

  // Check if lead is duplicate
  isDuplicate(email) {
    if (!email) return false;
    const normalized = email.toLowerCase().trim();
    return this.seenEmails.has(normalized);
  }

  // Add lead to seen list
  markAsSeen(email) {
    if (email) {
      this.seenEmails.add(email.toLowerCase().trim());
    }
  }

  // Search Google via SerpAPI
  async searchGoogle(keyword, region = 'us', timeframe = 'qdr:d') {
    if (!this.serpApiKey) {
      console.log('SerpAPI key not configured, skipping Google search');
      return [];
    }

    console.log(`Searching Google: "${keyword}" in ${region}`);
    
    try {
      const results = await new Promise((resolve, reject) => {
        getJson({
          api_key: this.serpApiKey,
          q: keyword,
          location: region,
          gl: region.toLowerCase(),
          tbs: timeframe, // qdr:d = past 24h, qdr:w = past week
          num: 50
        }, (json) => {
          if (json.error) reject(new Error(json.error));
          else resolve(json);
        });
      });

      const leads = [];
      if (results.organic_results) {
        for (const result of results.organic_results) {
          leads.push({
            id: uuidv4(),
            name: this.extractName(result.title),
            source: 'Google',
            sourceUrl: result.link,
            query: keyword,
            title: result.title,
            snippet: result.snippet,
            extractedAt: new Date().toISOString()
          });
        }
      }
      
      console.log(`Found ${leads.length} results from Google`);
      return leads;
    } catch (err) {
      console.error(`Google search error: ${err.message}`);
      return [];
    }
  }

  // Scrape Upwork via Apify
  async scrapeUpwork(keyword, maxResults = 100) {
    if (!this.apifyClient) {
      console.log('Apify not configured, skipping Upwork');
      return [];
    }

    console.log(`Scraping Upwork for: "${keyword}"`);
    
    try {
      // Using Upwork Jobs Scraper actor
      const run = await this.apifyClient.actor('memo23/upwork-jobs-scraper').call({
        searchQuery: keyword,
        maxItems: maxResults,
        sortBy: 'recency'
      });

      const { items } = await this.apifyClient.dataset(run.defaultDatasetId).listItems();
      
      const leads = items.map(job => ({
        id: uuidv4(),
        name: job.client?.name || 'Unknown',
        source: 'Upwork',
        sourceUrl: job.url,
        query: keyword,
        title: job.title,
        snippet: job.description?.substring(0, 500),
        budget: job.budget,
        postedAt: job.postedOn,
        extractedAt: new Date().toISOString()
      }));

      console.log(`Found ${leads.length} jobs from Upwork`);
      return leads;
    } catch (err) {
      console.error(`Upwork scrape error: ${err.message}`);
      return [];
    }
  }

  // Scrape Reddit via Apify
  async scrapeReddit(keyword, maxResults = 100) {
    if (!this.apifyClient) {
      console.log('Apify not configured, skipping Reddit');
      return [];
    }

    console.log(`Scraping Reddit for: "${keyword}"`);
    
    try {
      const run = await this.apifyClient.actor('trudax/reddit-scraper').call({
        searches: [keyword],
        maxPostsPerSearch: maxResults,
        sortBy: 'new',
        time: 'day' // Last 24 hours
      });

      const { items } = await this.apifyClient.dataset(run.defaultDatasetId).listItems();
      
      const leads = items.map(post => ({
        id: uuidv4(),
        name: post.author || 'Unknown',
        source: 'Reddit',
        sourceUrl: `https://reddit.com${post.permalink}`,
        query: keyword,
        title: post.title,
        snippet: post.selftext?.substring(0, 500),
        subreddit: post.subreddit,
        postedAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
        extractedAt: new Date().toISOString()
      }));

      console.log(`Found ${leads.length} posts from Reddit`);
      return leads;
    } catch (err) {
      console.error(`Reddit scrape error: ${err.message}`);
      return [];
    }
  }

  // Find email using Hunter.io
  async findEmail(name, domain) {
    if (!this.hunterApiKey) {
      return null;
    }

    try {
      const response = await fetch(
        `https://api.hunter.io/v2/email-finder?domain=${domain}&full_name=${encodeURIComponent(name)}&api_key=${this.hunterApiKey}`
      );
      const data = await response.json();
      
      if (data.data?.email) {
        return {
          email: data.data.email,
          confidence: data.data.confidence,
          verified: data.data.verification?.status === 'valid'
        };
      }
    } catch (err) {
      console.error(`Hunter API error: ${err.message}`);
    }
    return null;
  }

  // Verify email using Hunter.io
  async verifyEmail(email) {
    if (!this.hunterApiKey) {
      return null;
    }

    try {
      const response = await fetch(
        `https://api.hunter.io/v2/email-verifier?email=${email}&api_key=${this.hunterApiKey}`
      );
      const data = await response.json();
      
      return {
        email: email,
        status: data.data?.status,
        score: data.data?.score,
        verified: data.data?.status === 'valid'
      };
    } catch (err) {
      console.error(`Hunter verify error: ${err.message}`);
    }
    return null;
  }

  // Extract name from title/text
  extractName(text) {
    if (!text) return 'Unknown';
    // Simple extraction - can be improved with NLP
    const cleaned = text.replace(/[^\w\s]/g, ' ').trim();
    const words = cleaned.split(/\s+/).slice(0, 3);
    return words.join(' ') || 'Unknown';
  }

  // Extract email from text
  extractEmailFromText(text) {
    if (!text) return null;
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const matches = text.match(emailRegex);
    return matches ? matches[0] : null;
  }

  // Main extraction function
  async extract(options = {}) {
    const {
      keywords = ['book publishing', 'web development'],
      platforms = ['google', 'upwork', 'reddit'],
      maxPerPlatform = 50,
      region = 'us'
    } = options;

    console.log('\n========================================');
    console.log('Starting Lead Extraction');
    console.log(`Keywords: ${keywords.join(', ')}`);
    console.log(`Platforms: ${platforms.join(', ')}`);
    console.log('========================================\n');

    const allLeads = [];

    for (const keyword of keywords) {
      // Google Search
      if (platforms.includes('google')) {
        const googleLeads = await this.searchGoogle(keyword, region);
        allLeads.push(...googleLeads);
      }

      // Upwork
      if (platforms.includes('upwork')) {
        const upworkLeads = await this.scrapeUpwork(keyword, maxPerPlatform);
        allLeads.push(...upworkLeads);
      }

      // Reddit
      if (platforms.includes('reddit')) {
        const redditLeads = await this.scrapeReddit(keyword, maxPerPlatform);
        allLeads.push(...redditLeads);
      }

      // Add small delay between keywords to avoid rate limits
      await new Promise(r => setTimeout(r, 1000));
    }

    // Deduplicate
    const uniqueLeads = [];
    for (const lead of allLeads) {
      // Try to extract email from snippet
      const emailInText = this.extractEmailFromText(lead.snippet);
      if (emailInText) {
        lead.email = emailInText;
      }

      // Check for duplicates
      if (lead.email && this.isDuplicate(lead.email)) {
        console.log(`Skipping duplicate: ${lead.email}`);
        continue;
      }

      if (lead.email) {
        this.markAsSeen(lead.email);
      }

      uniqueLeads.push(lead);
    }

    this.leads = uniqueLeads;
    this.saveSeenLeads();

    console.log(`\nExtraction complete. Found ${uniqueLeads.length} unique leads.`);
    return uniqueLeads;
  }

  // Export to Excel
  exportToExcel(filename = 'leads.xlsx') {
    const outputDir = path.join(__dirname, '../output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, filename);
    
    const data = this.leads.map(lead => ({
      'Name': lead.name || '',
      'Email': lead.email || '',
      'Phone': lead.phone || '',
      'Source': lead.source || '',
      'Query/Service': lead.query || '',
      'Title': lead.title || '',
      'URL': lead.sourceUrl || '',
      'Posted At': lead.postedAt || '',
      'Extracted At': lead.extractedAt || ''
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');
    
    XLSX.writeFile(workbook, outputPath);
    console.log(`Exported ${this.leads.length} leads to ${outputPath}`);
    
    return outputPath;
  }

  // Export to JSON
  exportToJSON(filename = 'leads.json') {
    const outputDir = path.join(__dirname, '../output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, filename);
    fs.writeFileSync(outputPath, JSON.stringify(this.leads, null, 2));
    console.log(`Exported ${this.leads.length} leads to ${outputPath}`);
    
    return outputPath;
  }
}

module.exports = LeadExtractor;
