const env = require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs-extra');
const NodeCache = require("node-cache");

const app = express();
const cache = new NodeCache({stdTTL: process.env.cacheTimeoutSeconds, checkperiod: process.env.cacheCheckPeriod});
// Remove outdated download directories
cache.on("expired", (key, value) => {
    if (key.startsWith("dir_")) fs.remove(__dirname, 'downloaded', value)
});

async function run() {
    const browser = await puppeteer.launch({headless: true}); // set 'headless' to false for showing Chromium windows

    async function newPage() {
        return browser.newPage().then((page) => {
            page.setRequestInterception(true);
            // Intercept request and filter extra elements
            page.on('request', (req) => {
                if (req.resourceType() === 'stylesheet' ||
                    req.resourceType() === 'font' ||
                    req.resourceType() === 'image')
                    req.abort();
                else req.continue();
            });
            return page;
        });
    }

    const page = await newPage();
    await page.goto("https://rutracker.org/forum/tracker.php");
    await page.waitFor('#login-form-full');
    await page.type('#login-form-full [name=login_username]', process.env.rutrackerLogin);
    await page.type('#login-form-full [name=login_password]', process.env.rutrackerPassword);
    await page.click('#login-form-full [name=login]');

    app.listen(process.env.appPort, () => console.log(`Tracker search listening on http://localhost:${process.env.appPort}`));

    app.get('/health', (req, res) => res.send('ok'));

    app.get('/search/:query', async (req, res) => {
        const queryText = req.params.query;

        // Check from cache
        const cachedData = cache.get(queryText);
        if (cachedData) return res.json(cachedData); // send data

        // Open page
        const page = await newPage();
        await page.goto("https://rutracker.org/forum/tracker.php");

        // Do search
        await page.type('#title-search', queryText);
        await page.select('#o', '10'); // sort by seeders
        await page.evaluate(() => document.querySelector('#tr-submit-btn').click());
        await page.waitForNavigation();

        // Get values
        const data = await page.evaluate(() =>
            [...document.querySelectorAll('#search-results .tCenter')]
                .map(it => {
                    const titleElement = it.querySelector('.t-title a');
                    const sizeElement = it.querySelector('.tor-size > a');
                    return {
                        title: titleElement.innerText,
                        id: titleElement.dataset.topic_id,
                        size: sizeElement.innerText.replace(/[^\w.]/g, '')
                    }
                })
        );
        cache.set(queryText, data);
        page.close();

        res.json(data); // Send data
    });

    app.get('/download/:id', async (req, res) => {
        const id = req.params.id;
        const url = `https://rutracker.org/forum/dl.php?t=${id}`;

        // Create download directory
        const downloadPath = path.join(__dirname, 'downloaded', id);
        fs.ensureDirSync(downloadPath);
        cache.set(`dir_${id}`, id); // add dir to cache for removing in feature

        // Check already downloaded file
        const existedFileNames = fs.readdirSync(downloadPath);
        if (existedFileNames.length) {
            const existedFileName = existedFileNames[0];
            const ext = existedFileName.split('.').pop();
            if (ext !== 'crdownload') return res.sendFile(path.join(downloadPath, existedFileName))
        }

        // Open new page and allow downloading
        const page = await newPage();
        await page._client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadPath
        });

        // Download file
        await page.goto(url).catch(error => '');

        // Check file downloaded and send it to client
        let isFileDownloaded = false;
        const fileWatcher = fs.watch(downloadPath, (event, filename) => {
            isFileDownloaded = event === 'change' && !filename.endsWith('.crdownload');
            if (isFileDownloaded) {
                fileWatcher.close();
                page.close();
                res.setHeader('Content-disposition', `attachment; filename=${encodeURIComponent(filename)}`);
                res.sendFile(path.join(downloadPath, filename))
            }
        });

        // Check timeout
        setTimeout(() => {
            if (!isFileDownloaded) {
                fileWatcher.close();
                page.close();
                res.send(408); // send timeout error
            }
        }, process.env.downloadWaitingTimeout);
    });
}

run();