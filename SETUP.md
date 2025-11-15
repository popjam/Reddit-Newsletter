# Reddit to Kindle Newsletter - Cross-Platform Setup Guide

This guide helps you set up the Reddit to Kindle newsletter generator on Windows, Linux, or macOS.

## Quick Start

1. **Install Node.js** from https://nodejs.org/
2. **Clone/download** this project
3. **Run setup**: `npm run setup`
   - The setup wizard will configure email, Reddit settings, and **automatically set up daily scheduling**
4. **Generate newsletter**: `npm start`

> **✨ New!** The setup wizard can now automatically configure daily scheduling for you on both Windows and Linux/macOS!

## Platform-Specific Instructions

### Windows Setup

#### Prerequisites
- **Node.js**: Download from https://nodejs.org/
- **ImageMagick** (optional, for cover generation): https://imagemagick.org/script/download.php#windows

#### Installation Steps
1. Open **Command Prompt** or **PowerShell** as Administrator
2. Navigate to the project folder:
   ```cmd
   cd C:\path\to\reddit-to-kindle
   ```
3. Install dependencies:
   ```cmd
   npm install
   ```
4. Run setup wizard:
   ```cmd
   npm run setup
   ```

#### Running the Newsletter
```cmd
# Basic newsletter generation
npm start

# With updated book cover (requires ImageMagick)
npm run start:cover

# Using Windows batch script
run-newsletter.bat
```

#### Scheduling (Windows)
**Automatic Setup (Recommended)**
- The setup wizard (`npm run setup`) will automatically configure Windows Task Scheduler for you
- Just answer "yes" when asked about scheduling and provide your preferred time

**Manual Setup Options**
- **PowerShell Script**: Run `.\setup-daily-task.ps1` as Administrator
- **GUI Method**: Use Task Scheduler manually (see troubleshooting section below)

---

### Linux/Ubuntu Setup

#### Prerequisites
```bash
# Update package list
sudo apt update

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install ImageMagick (optional, for cover generation)
sudo apt install imagemagick
```

#### Installation Steps
```bash
# Navigate to project folder
cd /path/to/reddit-to-kindle

# Install dependencies
npm install

# Run setup wizard
npm run setup
```

#### Running the Newsletter
```bash
# Basic newsletter generation
npm start

# With updated book cover
npm run start:cover

# Using Linux script
bash run-newsletter.sh
```

#### Scheduling (Linux)
**Automatic Setup (Recommended)**
- The setup wizard (`npm run setup`) will automatically configure cron for you
- Just answer "yes" when asked about scheduling and provide your preferred time

**Manual Setup**
```bash
# Edit crontab manually
crontab -e

# Add this line for daily execution at 7:00 AM
0 7 * * * cd /path/to/reddit-to-kindle && bash run-newsletter.sh

# Check existing cron jobs
crontab -l
```

---

### macOS Setup

#### Prerequisites
```bash
# Install Homebrew (if not already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js
brew install node

# Install ImageMagick (optional, for cover generation)
brew install imagemagick
```

#### Installation Steps
```bash
# Navigate to project folder
cd /path/to/reddit-to-kindle

# Install dependencies
npm install

# Run setup wizard
npm run setup
```

#### Running the Newsletter
```bash
# Basic newsletter generation
npm start

# With updated book cover
npm run start:cover

# Using macOS script
bash run-newsletter.sh
```

#### Scheduling (macOS)
**Automatic Setup (Recommended)**
- The setup wizard (`npm run setup`) will automatically configure cron for you
- Just answer "yes" when asked about scheduling and provide your preferred time

**Manual Setup**
Same as Linux - use crontab:
```bash
# Edit crontab manually
crontab -e

# Add this line for daily execution at 7:00 AM
0 7 * * * cd /path/to/reddit-to-kindle && bash run-newsletter.sh
```

## Available Commands

| Command | Description |
|---------|-------------|
| `npm start` | Generate newsletter |
| `npm run start:cover` | Generate with updated cover (cross-platform) |
| `npm run start:cover:windows` | Windows cover generation |
| `npm run start:cover:linux` | Linux/macOS cover generation |
| `npm run setup` | Run setup wizard |
| `npm run setup:advanced` | Advanced setup options |
| `npm run reconfigure` | Reconfigure existing settings |
| `npm run check-process` | Check if newsletter is running |
| `npm run platform-info` | Show platform information |
| `npm run help` | Show help information |

## Cross-Platform Files

- **Windows**: `run-newsletter.bat`, `start-with-cover.bat`
- **Linux/macOS**: `run-newsletter.sh`, `start-with-cover.sh`
- **Cross-platform**: `process-checker.js`, `setup.js`

## Troubleshooting

### Common Issues

**Sharp module error on Windows:**
```cmd
# Remove node_modules and reinstall from Windows
rmdir /s node_modules
npm install
```

**ImageMagick not found:**
- Windows: Download from https://imagemagick.org/script/download.php#windows
- Linux: `sudo apt install imagemagick`
- macOS: `brew install imagemagick`

**Permission denied (Linux/macOS):**
```bash
chmod +x run-newsletter.sh
chmod +x start-with-cover.sh
```

**Automatic scheduling failed:**
- **Windows**: The setup wizard needs elevated permissions. Try running as Administrator or use the manual PowerShell script
- **Linux/macOS**: Cron setup failed. Check if cron service is running: `sudo systemctl status cron`

**Manual Task Scheduler Setup (Windows):**
1. Search "Task Scheduler" in Start menu
2. Click "Create Basic Task"
3. Name: "Reddit Newsletter Generator"
4. Trigger: Daily at desired time
5. Action: "Start a program"
6. Program: `C:\path\to\reddit-to-kindle\run-newsletter.bat`
7. Arguments: `auto`

**Cron job not running (Linux/macOS):**
```bash
# Check cron service
sudo systemctl status cron

# Check cron logs
grep CRON /var/log/syslog

# View your cron jobs
crontab -l
```

### Checking Status

```bash
# Check if Node.js process is running
npm run check-process

# View recent log
cat newsletter-log.txt

# Show platform info
npm run platform-info
```

### Getting Help

- Check the main README.md for configuration details
- Run `npm run help` for command-line options
- Check `newsletter-log.txt` for execution logs
- Verify your `user-config.json` settings

## Configuration Files

- `user-config.json` - Your email and Reddit settings
- `config.js` - Default configuration template
- `newsletter-log.txt` - Execution logs (recreated each run)

## Next Steps

After setup is complete:
1. Test with `npm start` to generate your first newsletter
2. Set up daily scheduling using your platform's method
3. Check email for the generated EPUB newsletter
4. Customize subreddit feeds in `user-config.json` as needed