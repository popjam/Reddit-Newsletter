#!/bin/bash
SCRIPT_DIR=$(dirname -- "$(readlink -f -- "$0")")
cd "$SCRIPT_DIR" || exit 1

# Define Log File
export LOG_FILE="$SCRIPT_DIR/newsletter-log.txt"

# Log Header
echo "" >> "$LOG_FILE"
echo "===============================================" >> "$LOG_FILE"
echo "Batch Run Started: $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"

# Check for Node
if ! command -v node >/dev/null 2>&1; then
    echo "❌ ERROR: Node.js not found"
    echo "Error: Node.js not found" >> "$LOG_FILE"
    exit 1
fi

echo "🚀 Starting newsletter generation..."

# Run npm start. It will pick up the LOG_FILE env var.
npm start

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ Success"
    echo "Batch Run Completed: $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
else
    echo "❌ Failed"
    echo "Batch Run Failed: $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
fi