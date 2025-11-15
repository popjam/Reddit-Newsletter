#!/bin/bash
SCRIPT_DIR=$(dirname -- "$(readlink -f -- "$0")")
cd "$SCRIPT_DIR" || { echo "Failed to change directory to $SCRIPT_DIR"; exit 1; }
echo "ℹ️  Updating book cover with today's date..."
DATE=$(date +"%B %d, %Y")
convert "$SCRIPT_DIR/reddit_book_cover.jpg" \
    -gravity South -stroke '#000C' -strokewidth 2 -pointsize 40 \
    -annotate +0+720 "$DATE" -stroke none -fill white \
    -annotate +0+720 "$DATE" "$SCRIPT_DIR/reddit_book_cover_with_date.jpg"
if [ $? -ne 0 ]; then
  echo "❌ Error: Failed to update book cover."
  exit 1
fi
echo "✅ Book cover updated successfully."
echo "--------------------------------------------------"
npm start
