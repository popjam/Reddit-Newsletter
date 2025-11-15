#!/usr/bin/env node

// Simple test to isolate the quota fill issue
import fs from 'fs';

console.log('Testing quota fill logic...\n');

// Simulate the conditions
const validEntries = [{title: 'Post 1'}, {title: 'Post 2'}, {title: 'Post 3'}]; // 3 valid posts
const postsPerSubreddit = 5; // Target: 5 posts
const resolvedConfig = {
    allowImagePostsIfCantFindOtherPosts: true,
    skipImageAndGalleryPosts: true
};

// Simulate some entries with images
const entries = [
    {title: 'Text Post 1', content: [{_: 'Text content'}]}, // Text post (already in validEntries)
    {title: 'Image Post 1', content: [{_: '<a href="https://example.com/image.jpg">[link]</a>'}]}, // Image post
    {title: 'Text Post 2', content: [{_: 'More text'}]}, // Text post (already in validEntries)
    {title: 'Gallery Post 1', content: [{_: '<a href="https://reddit.com/gallery/xyz">[link]</a>'}]}, // Gallery post
    {title: 'Text Post 3', content: [{_: 'Even more text'}]}, // Text post (already in validEntries)
    {title: 'Image Post 2', content: [{_: '<a href="https://i.imgur.com/pic.png">[link]</a>'}]} // Another image
];

console.log('Initial state:');
console.log(`- Valid entries: ${validEntries.length}`);
console.log(`- Target posts: ${postsPerSubreddit}`);
console.log(`- Total entries available: ${entries.length}`);
console.log(`- Allow image fallback: ${resolvedConfig.allowImagePostsIfCantFindOtherPosts}`);
console.log(`- Skip images normally: ${resolvedConfig.skipImageAndGalleryPosts}`);

console.log('\nQuota fill conditions:');
console.log(`- validEntries.length < postsPerSubreddit: ${validEntries.length < postsPerSubreddit}`);
console.log(`- allowImagePostsIfCantFindOtherPosts: ${resolvedConfig.allowImagePostsIfCantFindOtherPosts}`);
console.log(`- skipImageAndGalleryPosts: ${resolvedConfig.skipImageAndGalleryPosts}`);

const shouldTriggerQuotaFill = validEntries.length < postsPerSubreddit && 
                               resolvedConfig.allowImagePostsIfCantFindOtherPosts && 
                               resolvedConfig.skipImageAndGalleryPosts;

console.log(`- Should trigger quota fill: ${shouldTriggerQuotaFill}`);

if (shouldTriggerQuotaFill) {
    console.log(`\nQuota fill should trigger. Need ${postsPerSubreddit - validEntries.length} more posts.`);
    console.log(`Scanning ${entries.length} entries...`);
    
    // Mock image detection functions
    function isImagePost(content, url, title) {
        return content.includes('image.jpg') || content.includes('imgur.com');
    }
    
    function isGalleryPost(content, url, title) {
        return content.includes('reddit.com/gallery');
    }
    
    for (let i = 0; i < entries.length && validEntries.length < postsPerSubreddit; i++) {
        const entry = entries[i];
        const postContent = entry.content?.[0]?._ || '';
        
        console.log(`\nChecking entry ${i}: "${entry.title}"`);
        console.log(`- Content: ${postContent.substring(0, 50)}...`);
        console.log(`- Already processed: ${validEntries.some(v => v.title === entry.title)}`);
        
        if (validEntries.some(v => v.title === entry.title)) {
            console.log('  → Skipping (already processed)');
            continue;
        }
        
        const isImage = isImagePost(postContent);
        const isGallery = isGalleryPost(postContent);
        
        console.log(`- Is image: ${isImage}`);
        console.log(`- Is gallery: ${isGallery}`);
        
        if (isImage || isGallery) {
            console.log('  → ADDING TO QUOTA FILL!');
            validEntries.push({title: entry.title + ' (quota fill)'});
            console.log(`  → Valid entries now: ${validEntries.length}/${postsPerSubreddit}`);
        } else {
            console.log('  → Not an image/gallery post');
        }
    }
    
    console.log(`\nFinal result: ${validEntries.length}/${postsPerSubreddit} posts`);
    validEntries.forEach((entry, i) => console.log(`${i+1}. ${entry.title}`));
} else {
    console.log('\nQuota fill would not trigger.');
}