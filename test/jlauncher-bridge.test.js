import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSettings, cleanSubreddit, publicSettings, applySettings, moveToShared, percentOf, issueName, sortIssues, scrub } from '../jlauncher-bridge.js';
import { loadUserConfig, splitShared } from '../config-loader.js';

const userConfig = {
    email: { provider: 'gmx', gmx: { email: 'me@example.com', password: 'secret-pass' }, kindle: { email: 'me@kindle.com' } },
    reddit: {
        enableOAuth2: false,
        oauth2: { clientId: 'id', clientSecret: 'oauth-secret', password: 'reddit-pass' },
        sourceMode: 'html',
        subreddits: ['worldnews', { name: 'science', postsPerSubreddit: 5 }],
        defaults: { postsPerSubreddit: 10, commentsPerPost: 0, timeframe: 'week' },
    },
    epub: { title: 'Reddit Daily Newsletter', hierarchicalTOC: true },
};

test('public settings leave out email and Reddit credentials', () => {
    const s = publicSettings(userConfig);
    const text = JSON.stringify(s);
    for (const secret of ['secret-pass', 'oauth-secret', 'reddit-pass', 'me@example.com', 'me@kindle.com']) {
        assert.ok(!text.includes(secret), secret);
    }
    assert.deepEqual(s.reddit.subreddits, ['worldnews', { name: 'science', postsPerSubreddit: 5 }]);
    assert.equal(s.reddit.defaults.timeframe, 'week');
    // Filled in from the program's defaults
    assert.equal(s.reddit.defaults.skipAutoModerator, true);
    assert.equal(s.epub.title, 'Reddit Daily Newsletter');
    // What both share isn't a profile's
    assert.equal(s.reddit.imageOptimizationPreset, undefined);
    assert.equal(s.reddit.sourceMode, undefined);
    assert.equal(s.epub.hierarchicalTOC, undefined);
});

test('shared settings are only the shared ones, without credentials', () => {
    const s = publicSettings(userConfig, 'shared');
    const text = JSON.stringify(s);
    for (const secret of ['secret-pass', 'oauth-secret', 'reddit-pass', 'me@example.com', 'me@kindle.com']) {
        assert.ok(!text.includes(secret), secret);
    }
    assert.equal(s.reddit.sourceMode, 'html');
    assert.equal(s.reddit.imageOptimizationPreset, 'default');
    assert.equal(s.reddit.galleryFirstImageOnly, false);
    assert.equal(s.reddit.articleImages, 'all');
    assert.equal(s.reddit.subreddits, undefined);
    assert.equal(s.reddit.defaults, undefined);
    assert.equal(s.epub.title, undefined);
    assert.equal(s.epub.hierarchicalTOC, true);
});

test('shared changes are checked and kept to the shared settings', () => {
    const next = applySettings({ email: { gmx: { password: 'secret-pass' } } }, {
        reddit: { galleryFirstImageOnly: true, articleImages: 'top', subreddits: ['news'], defaults: { commentsPerPost: 3 } },
        epub: { title: 'x', generateDatedCover: false },
    }, 'shared');
    assert.equal(next.email.gmx.password, 'secret-pass');
    assert.equal(next.reddit.galleryFirstImageOnly, true);
    assert.equal(next.reddit.articleImages, 'top');
    assert.equal(next.reddit.subreddits, undefined);
    assert.equal(next.reddit.defaults, undefined);
    assert.equal(next.epub.title, undefined);
    assert.equal(next.epub.generateDatedCover, false);
    assert.equal(applySettings({}, { reddit: { articleImages: 'some' } }, 'shared').reddit.articleImages, undefined);
});

test('the profiles move what they share into the shared file', () => {
    const daily = { ...structuredClone(userConfig), reddit: { ...structuredClone(userConfig.reddit), defaults: { timeframe: 'day' } } };
    const weekly = structuredClone(userConfig);
    weekly.epub.hierarchicalTOC = false;
    const { shared, profiles } = moveToShared({ daily, weekly });
    assert.equal(shared.email.gmx.password, 'secret-pass');
    assert.equal(shared.reddit.oauth2.clientSecret, 'oauth-secret');
    assert.equal(shared.reddit.sourceMode, 'html');
    // The weekly wins where they differ, and the daily keeps its own value
    assert.equal(shared.epub.hierarchicalTOC, false);
    assert.equal(profiles.daily.epub.hierarchicalTOC, true);
    assert.equal(profiles.weekly.epub.hierarchicalTOC, undefined);
    for (const p of Object.values(profiles)) {
        assert.equal(p.email, undefined);
        assert.equal(p.reddit.oauth2, undefined);
        assert.equal(p.reddit.sourceMode, undefined);
        assert.ok(p.reddit.subreddits.length);
        assert.equal(p.epub.title, 'Reddit Daily Newsletter');
    }
    assert.equal(profiles.daily.reddit.defaults.timeframe, 'day');
});

test('splitting leaves the original alone', () => {
    const { shared, own } = splitShared(userConfig);
    assert.equal(shared.reddit.sourceMode, 'html');
    assert.equal(own.reddit.sourceMode, undefined);
    assert.equal(userConfig.reddit.sourceMode, 'html');
});

test('a run reads defaults, then the shared file, then the profile', () => {
    const { config } = loadUserConfig({ profileFile: 'test/does-not-exist.json' });
    assert.equal(config.reddit.articleImages !== undefined, true);
});

test('subreddit names and overrides are checked', () => {
    assert.equal(cleanSubreddit('AskReddit'), 'AskReddit');
    assert.equal(cleanSubreddit('../etc'), null);
    assert.equal(cleanSubreddit({ name: 'all', sort: 'controversial', bogus: 1 }).bogus, undefined);
    assert.equal(cleanSubreddit({ name: 'all', sort: 'sideways' }), 'all');
    assert.deepEqual(cleanSubreddit({ name: 'tinder', timeframe: 'day', postsPerSubreddit: '10' }), { name: 'tinder', timeframe: 'day', postsPerSubreddit: 10 });
});

test('cleaning drops unknown keys and bad values', () => {
    const s = cleanSettings({
        email: { gmx: { password: 'x' } },
        reddit: { sourceMode: 'ftp', downloadImages: 'yes', enableOAuth2: true, defaults: { commentsPerPost: -1, sort: 'top' }, subreddits: { 0: 'news', 2: 'aus' } },
        epub: { title: '  Weekly  ', creator: 'x' },
    });
    assert.deepEqual(s, { reddit: { defaults: { sort: 'top' }, subreddits: ['news', 'aus'] }, epub: { title: 'Weekly' } });
    // A profile can't set what's shared
    assert.equal(cleanSettings({ reddit: { downloadImages: false } }).reddit.downloadImages, undefined);
});

test('applying keeps email and credentials and replaces what the phone changed', () => {
    const next = applySettings(userConfig, {
        reddit: { randomizeSubredditOrder: true, defaults: { commentsPerPost: 3 }, subreddits: ['aus', { name: 'all', sort: 'controversial' }] },
        epub: { title: 'Weekly' },
        email: { gmx: { password: 'hacked' } },
    });
    assert.equal(next.email.gmx.password, 'secret-pass');
    assert.equal(next.reddit.oauth2.clientSecret, 'oauth-secret');
    assert.equal(next.reddit.randomizeSubredditOrder, true);
    assert.equal(next.reddit.defaults.commentsPerPost, 3);
    assert.equal(next.reddit.defaults.timeframe, 'week');
    assert.deepEqual(next.reddit.subreddits, ['aus', { name: 'all', sort: 'controversial' }]);
    assert.equal(next.epub.title, 'Weekly');
    assert.equal(next.epub.hierarchicalTOC, true);
    // The original isn't changed
    assert.equal(userConfig.reddit.defaults.commentsPerPost, 0);
});

test('an empty subreddit list never replaces the real one', () => {
    const next = applySettings(userConfig, { reddit: { subreddits: [] } });
    assert.equal(next.reddit.subreddits.length, 2);
});

test('percent follows the stages', () => {
    assert.equal(percentOf({ stage: 'subreddits', index: 0, total: 61 }), 0);
    assert.equal(percentOf({ stage: 'subreddits', index: 12, total: 61 }), 17);
    assert.equal(percentOf({ stage: 'book' }), 92);
    assert.equal(percentOf({ stage: 'send' }), 96);
    assert.equal(percentOf({ stage: 'done' }), 100);
    assert.equal(percentOf(null), 0);
});

test('issues are named by profile and kept per profile', () => {
    assert.equal(issueName('daily', 'reddit_2026-11-23_21-40.epub'), 'daily_2026-11-23_21-40.epub');
    const files = [
        { name: 'daily_2026-11-20_07-00.epub', size: 1 },
        { name: 'daily_2026-11-23_07-00.epub', size: 2 },
        { name: 'weekly_2026-11-22_19-25.epub', size: 3 },
        { name: 'daily_2026-11-21_07-00.epub', size: 4 },
        { name: 'notes.txt', size: 5 },
    ];
    const { kept, extra } = sortIssues(files, { daily: 2, weekly: 4 });
    assert.deepEqual(kept.map(i => i.file), ['daily_2026-11-23_07-00.epub', 'weekly_2026-11-22_19-25.epub', 'daily_2026-11-21_07-00.epub']);
    assert.deepEqual(extra.map(i => i.file), ['daily_2026-11-20_07-00.epub']);
    assert.equal(kept[0].date, '2026-11-23 07:00');
});

test('secrets are scrubbed from messages', () => {
    assert.equal(scrub('login failed for secret-pass', ['secret-pass']), 'login failed for ***');
    assert.equal(scrub('cookie reddit_session=abc.def; x=1', []), 'cookie reddit_session=***; x=1');
});
