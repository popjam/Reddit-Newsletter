# Reddit-to-Kindle Newsletter Generator

**Transform Reddit into your personalized daily newsletter, delivered straight to your Kindle!**

## 🚀 Quick Start

1. **Clone and install:**
   ```bash
   git clone https://github.com/jstriblet/reddit-to-kindle.git
   cd reddit-to-kindle
   npm install
   ```

2. **Run the interactive setup:**
   ```bash
   npm run setup
   ```
   *The setup wizard will configure email, Reddit settings, and can automatically set up daily scheduling for you!*

3. **Generate your first newsletter:**
   ```bash
   npm start
   ```

That's it! Your personalized Reddit newsletter will be automatically sent to your Kindle.

> **📋 Need platform-specific setup help?** See [SETUP.md](SETUP.md) for detailed Windows, Linux, and macOS instructions.

## 📖 Description

Reddit-to-Kindle is a powerful Node.js application that converts Reddit content into beautifully formatted EPUB files, perfect for reading on your Kindle or any eBook reader. It fetches posts from your favorite subreddits, includes top comments, and organizes everything into a clean, readable newsletter format.

![Newsletter Examples](https://github.com/jstriblet/Reddit-to-Kindle/assets/12757245/6c589315-64e3-47a6-947e-38346784e5db)

## ✨ Features

### 📰 **Content Curation**
- Fetch top posts from any subreddits
- Include threaded comments with discussions
- Automatic video post filtering
- Image downloading and optimization
- External article parsing with Mercury

### 🎨 **Beautiful Formatting**
- Clean, Kindle-optimized EPUB format
- Organized by subreddit with navigation
- Simplified table of contents (customizable)
- Responsive images and layouts
- Proper typography for eReaders

### ⚡ **Smart Features**
- Reddit OAuth2 support for better rate limits
- Robust HTML sanitization for EPUB compatibility
- Automatic image optimization and conversion
- Duplicate title removal for self-posts
- Configurable per-subreddit settings

### 📧 **Seamless Delivery**
- Direct Kindle email delivery
- Gmail and GMX support
- Automatic EPUB validation
- Error handling and retry logic

## 🛠️ Installation & Setup

### Prerequisites
- Node.js 18+ 
- npm or yarn

### Step-by-Step Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/jstriblet/reddit-to-kindle.git
   cd reddit-to-kindle
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run the interactive setup wizard:**
   ```bash
   npm run setup
   ```

The setup wizard will guide you through:

#### 📧 Email Configuration
- **Gmail setup:** The wizard will explain how to create App Passwords for secure authentication
- **GMX setup:** Simple username/password configuration  
- **Kindle email:** Instructions on finding your Kindle email and adding your sender to the approved list

#### 🔑 Reddit OAuth (Recommended)
- **Why use OAuth:** Higher rate limits (60 requests/minute vs 10), better reliability
- **Setup instructions:** Step-by-step guide to create a Reddit app
- **Optional:** You can skip this for basic usage

#### 📋 Newsletter Preferences
- **Subreddit selection:** Enter your favorite subreddits (e.g., `worldnews, technology, AskReddit`)
- **Posts per subreddit:** How many posts to include (1-10)
- **Comments per post:** How many top comments to include (0-10)
- **Time period:** Daily, weekly, monthly, or yearly top posts
- **Image downloads:** Whether to include images in your newsletter

### Manual Configuration (Advanced)

If you prefer manual setup, you can edit `config.js` directly:

```javascript
// Example configuration
export const redditConfig = {
    subreddits: ['worldnews', 'technology', 'programming'],
    defaults: {
        postsPerSubreddit: 3,
        commentsPerPost: 5,
        sort: 'top',
        timeframe: 'week'
    }
};
```

## 📚 Usage

### Basic Commands

```bash
# Generate and send newsletter
npm start

# Reconfigure settings
npm run setup

# Advanced setup with all options
npm run setup:advanced

# Show help
npm run help
```

### Advanced Usage

#### Custom Subreddit Configuration
```javascript
// In config.js - override defaults per subreddit
{
    name: 'AskReddit',
    postsPerSubreddit: 2,
    commentsPerPost: 8,
    sort: 'controversial'
}
```

#### Email Providers

**Gmail Setup:**
1. Enable 2-Factor Authentication
2. Go to Google Account Settings > Security > App Passwords
3. Generate a new app password
4. Use this password (not your regular Gmail password)

**GMX Setup:**
1. Enable POP3/IMAP in GMX settings
2. Use your regular GMX password

#### Kindle Email Setup
1. Find your Kindle email: Kindle App > Settings > Send to Kindle Email
2. Add your email to approved senders: Amazon Account > Manage Your Content and Devices > Personal Document Settings

## 🚀 Automation

### Cron Jobs (Linux/Mac)
Set up automatic daily newsletters:

```bash
# Edit crontab
crontab -e

# Add this line for daily 8 AM delivery
0 8 * * * cd /path/to/reddit-to-kindle && npm start
```

### Windows Task Scheduler
1. Open Task Scheduler
2. Create Basic Task
3. Set trigger (daily, weekly, etc.)
4. Set action to run: `cmd /c "cd C:\path\to\reddit-to-kindle && npm start"`

### Docker Support
```bash
# Build and run with Docker
docker build -t reddit-to-kindle .
docker run -v $(pwd)/config:/app/config reddit-to-kindle
```

## 🎯 Configuration Options

### Global Settings
- **Image downloads:** Enable/disable image embedding
- **Image optimization:** Automatic resizing and compression
- **Rate limiting:** Configurable delays for Reddit API
- **Error handling:** Retry logic and timeout settings

### Per-Subreddit Settings
- **Post count:** Override global post limit
- **Comment count:** Override global comment limit  
- **Sorting:** hot, new, top, controversial, best, rising
- **Time period:** hour, day, week, month, year, all
- **Content filtering:** Include/exclude video posts, internal links

### EPUB Settings
- **Simplified TOC:** Show only subreddit sections (default: true)
- **Custom title:** Personalize your newsletter title
- **Language settings:** Support for international content

## 🔧 Troubleshooting

### Common Issues

#### "E999—Send to Kindle Internal Error"
- **Fixed!** Latest version includes robust HTML sanitization
- Ensures EPUB compatibility with Kindle's processing system
- Validates EPUB structure before sending

#### Missing Images
- Check image download settings in config
- Verify image URLs are accessible
- Large images are automatically optimized

#### Rate Limiting
- Set up Reddit OAuth2 for higher limits
- Increase delays between requests in config
- Monitor rate limit messages in output

#### Email Delivery Issues
- Verify sender email is in Kindle's approved list
- Check email credentials and app passwords
- Confirm Kindle email address is correct

### Debug Mode
```bash
# Run with verbose logging
DEBUG=* npm start

# Check EPUB validation
npx epubcheck reddit_YYYY-MM-DD_HH-MM.epub
```

## 🆕 Latest Features (v2.0)

### New in This Version
- **Interactive Setup Wizard:** No more manual config editing!
- **Simplified Table of Contents:** Cleaner navigation
- **Enhanced HTML Sanitization:** Fixes Kindle delivery issues
- **Better Video Detection:** Smarter filtering of video content
- **Improved Self-Post Handling:** No more duplicate titles
- **OAuth2 Integration:** Better Reddit API access

### Migration from v1.x
Existing users can run `npm run setup` to migrate to the new configuration system while preserving their settings.

## 🤝 Contributing

Contributions are welcome! Here's how to get started:

1. Fork the repository
2. Create a feature branch: `git checkout -b my-feature`
3. Make your changes and test thoroughly
4. Submit a pull request with a clear description

### Development Setup
```bash
# Install dependencies
npm install

# Run tests
npm test

# Lint code
npm run lint
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 💖 Support

I work on this project in my spare time between my day job and raising my daughter. If you find this useful, please consider:

- ⭐ Starring the repository
- 🐛 Reporting bugs and issues
- 💡 Suggesting new features
- ☕ [Buying me a coffee](https://buymeacoffee.com/striblet)

## 📞 Support & Community

- **Issues:** [GitHub Issues](https://github.com/jstriblet/reddit-to-kindle/issues)
- **Discussions:** [GitHub Discussions](https://github.com/jstriblet/reddit-to-kindle/discussions)
- **Updates:** Watch the repository for updates

---

**Happy Reading!** 📚✨