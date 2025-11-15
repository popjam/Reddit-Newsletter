# Reddit Newsletter

**Transform Reddit into a personalized daily or weekly newsletter, delivered to your Kindle or Ereader device!**

## Quick Start

1. **Clone and install:**
   ```bash
   git clone https://github.com/popjam/Reddit-Newsletter.git
   cd Reddit-Weekly-Newsletter
   npm install
   ```

2. **Run the interactive setup:**
   ```bash
   npm run setup
   ```
   *The setup wizard will configure email, Reddit settings, and can automatically set up daily scheduling for you.*

3. **Generate your first newsletter:**
   ```bash
   npm start
   ```

That's it! Your personalized Reddit newsletter will be automatically sent to your Kindle.

> See [SETUP.md](SETUP.md) for detailed Windows, Linux, and macOS instructions.

## Description

Reddit-Newsletter is a program that converts Reddit content into a formatted EPUB with a table of contents. You can specify any subreddits you want to be included in the newsletter, the time range to fetch posts from, the sorting method, how comments are displayed, and more. It will attempt to include the text from articles and self posts so you don't need to use any inbuilt browsers.

| Cover | Main Contents | Subreddit Title Page |
|-----------|---------|---------|
| <img src="https://github.com/user-attachments/assets/9b32ec1b-9db3-4572-a335-2c485776408b" height="300"> | <img src="https://github.com/user-attachments/assets/5cf5fd4e-fd46-4433-a959-05bc3257483c" height="300"> | <img src="https://github.com/user-attachments/assets/f5421890-ee07-4005-a7fd-9abccc782fe0" height="300"> |

| Subreddit Contents | Post View | Article View |
|---------|---------|---------|
| <img src="https://github.com/user-attachments/assets/b554c6a1-a9e7-4bd2-b03e-620d0b3f0071" height="300"> | <img src="https://github.com/user-attachments/assets/ed76da90-65f9-4f4d-b8c5-1d7c7bf3b9d2" height="300"> | <img src="https://github.com/user-attachments/assets/8952be44-1221-4be6-bc9a-4248331d4b6a" height="300"> |





## Installation & Setup

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

#### Email Configuration
- **Gmail setup:** The wizard will explain how to create App Passwords for secure authentication
- **GMX setup:** Simple username/password configuration  
- **Kindle email:** Instructions on finding your Kindle email and adding your sender to the approved list

#### Reddit OAuth (Recommended)
- **Why use OAuth:** Higher rate limits (60 requests/minute vs 10), better reliability
- **Setup instructions:** Step-by-step guide to create a Reddit app
- **Optional:** You can skip this for basic usage

#### Newsletter Preferences
- **Subreddit selection:** Enter your favorite subreddits (e.g., `worldnews, technology, AskReddit`)
- **Posts per subreddit:** How many posts to include (1-10)
- **Comments per post:** How many top comments to include (0-10)
- **Time period:** Daily, weekly, monthly, or yearly top posts
- **Image downloads:** Whether to include images in your newsletter

### Manual Configuration (Advanced)

If you prefer manual setup, you can edit `user-config.json` directly:

```javascript
// Example configuration
"subreddits": [
      "popular",
      "all",
      "worldnews",
      "hotdogs",
      "digitalminimalism",
      "denmark",
      "aliens",
      "chess",
      "AskHistorians",
      "houseplants",
      {
        "name": "AmItheAsshole",
        "sort": "controversial"
      }
    ],
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

## Automation

### Cron Jobs (Linux/Mac)
Set up automatic daily newsletters:

```bash
# Edit crontab
crontab -e

# Add this line for daily 8 AM delivery
0 8 * * * cd /path/to/reddit-newsletter && npm start
```

### Windows Task Scheduler
1. Open Task Scheduler
2. Create Basic Task
3. Set trigger (daily, weekly, etc.)
4. Set action to run: `cmd /c "cd C:\path\to\reddit-newsletter && npm start"`

## Configuration Options

Configurations can be made in user-config.json. Subreddit configurations can be global or subreddit specific.

### Subreddit Settings
- **commentsPerPost:** Amount of top level comments for each post.
- **sort:** hot, new, top, controversial, best, rising
- **timeframe:** hour, day, week, month, year, all
- **includeInternalLinks:** Include/exclude self posts
- **skipUnfetchableArticles:** If the articles text cannot be fetched, skip the post.
- **commentStyle:** threaded or nested. Nested will include all child comments up to the specified depth. Threaded will only include the top "chain" of comments up to the specified depth, better simulating a conversation.
- **minCommentLength:** Will skip comments under this amount of characters. In threaded, only applies to top level comments.

### General Settings
- **imageOptimizationPreset:** default, aggressive, extreme

### EPUB Settings
- **simplifiedTOC:** Show only subreddit sections (default: true)
- **hierarchicalTOC:** Show only subreddit sections (default: true)
- **title:** Personalize your newsletter title

### Other Settings
Rate limiting and timeout, image size, and cover generation settings can be modified in config.js.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
