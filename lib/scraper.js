const { chromium } = require('playwright-core');
const cheerio = require('cheerio');
const { solveCaptcha } = require('./ocr');

// Persistent instances
let browserInstance = null;
let browserContext = null;


async function getBrowser() {
    if (!browserInstance) {
        const { chromium } = require('playwright-core');
        let launchOptions = {};

        // Check if running on Vercel or AWS Lambda
        if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
            console.log('[Scraper] Using Vercel/Lambda Chromium (Min + Remote)');
            const chromiumPack = require('@sparticuz/chromium-min');

            // Remote URL for the compatible Chromium pack (v121.0.0 for sparticuz/chromium-min@121+)
            // Note: Update this URL if you upgrade the package to match the major version.
            const remotePack = "https://github.com/Sparticuz/chromium/releases/download/v121.0.0/chromium-v121.0.0-pack.tar";

            launchOptions = {
                args: chromiumPack.args,
                defaultViewport: chromiumPack.defaultViewport,
                executablePath: await chromiumPack.executablePath(remotePack),
                headless: chromiumPack.headless,
                ignoreHTTPSErrors: true,
            };
        } else {
            console.log('[Scraper] Using Local Chrome');
            // Local development logic - try to find local chrome
            launchOptions = {
                channel: 'chrome',
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            };
        }

        browserInstance = await chromium.launch(launchOptions);

        // Create a single context that we can reuse
        browserContext = await browserInstance.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        });
    }
    return browserContext;
}

async function scrapeStatus(cnrNumber) {
    let attempt = 0;

    while (true) {
        attempt++;
        if (attempt > 100) attempt = 1; // Prevent overflow in logs

        console.log(`[Scraper] Attempt ${attempt} (Optimization) for CNR: ${cnrNumber}`);
        let page = null;

        try {
            const context = await getBrowser();
            page = await context.newPage();

            // FAST SETUP: Block heavy resources
            await page.route('**/*', (route) => {
                const req = route.request();
                const type = req.resourceType();
                // Block ONLY fonts, media, stylesheets. Allow images to avoid breaking Captcha.
                if (['media', 'font', 'stylesheet'].includes(type)) {
                    return route.abort();
                }
                return route.continue();
            });

            // FAST NAV: domcontentloaded is enough (wait for HTML, not network idle)
            await page.goto('https://hcmadras.tn.gov.in/case_status_mas.php', {
                timeout: 300000,
                waitUntil: 'domcontentloaded'
            });

            // Fast interactions
            await page.click('a[href="#resp-tab3"]');
            await page.waitForSelector('#case_type_name_cnr', { state: 'visible', timeout: 5000 }); // Fast fail

            await page.fill('#case_type_name_cnr', cnrNumber);

            // OCR
            const captchaElement = await page.$('#cnr_captcha_img');
            if (!captchaElement) throw new Error('Captcha image not found');

            // Wait for image to actually load content
            await page.waitForFunction(() => {
                const img = document.querySelector('#cnr_captcha_img');
                return img && img.complete && img.naturalWidth > 0;
            }, { timeout: 5000 });

            await page.waitForTimeout(200); // reduced wait

            const captchaBuffer = await captchaElement.screenshot();
            let captchaText = await solveCaptcha(captchaBuffer);
            console.log(`[Scraper] OCR: "${captchaText}"`);

            if (captchaText) captchaText = captchaText.replace(/[^0-9]/g, '');
            if (!captchaText || captchaText.length < 4) throw new Error('Bad OCR');

            await page.fill('#cnr_captcha', captchaText);

            // Submit
            await page.click('#cnr_searchform input[type="submit"]');

            try {
                // Shorter timeout for race (fast path)
                await Promise.race([
                    page.waitForSelector('#cnrno_search_result table', { state: 'visible', timeout: 5000 }),
                    page.waitForSelector('#cnrno_search_result span.error', { state: 'visible', timeout: 5000 }),
                    // Fallback check if immediate success didn't happen
                    page.waitForTimeout(2000)
                ]);
            } catch (e) { }

            // WAIT logic: If table likely exists, great. If not, wait a bit more in case of lag
            // But we don't want to wait 5 mins unless necessary.
            try {
                await page.waitForSelector('#cnrno_search_result', { timeout: 2000 });
            } catch (e) { }

            const resultHtml = await page.innerHTML('#cnrno_search_result');
            const pageText = await page.innerText('body');

            // --- STOP CONDITIONS ---
            if (pageText.includes('Invalid Captcha') || pageText.includes('Incorrect Captcha') || pageText.includes('Captcha not matching')) {
                throw new Error('Invalid Captcha');
            }

            if (resultHtml.includes('spinner')) {
                // If spinner is STILL there, we might need to wait longer
                try {
                    await page.waitForSelector('#cnrno_search_result img[src*="spinner"]', { state: 'detached', timeout: 300000 });
                    var newHtml = await page.innerHTML('#cnrno_search_result');
                    if (newHtml.includes('record not found') || newHtml.toLowerCase().includes('no search result')) {
                        await page.close();
                        return { success: true, data: { status: 'Record Not Found', message: 'No records found.' }, html: newHtml };
                    }
                    if (await page.$('#cnrno_search_result table')) {
                        const parseResult = parseHtml(newHtml);
                        await page.close();
                        return { success: true, data: parseResult.data, html: newHtml };
                    }
                } catch (e) {
                    throw new Error('Timeout waiting for spinner');
                }
            }

            const lowerHtml = resultHtml.toLowerCase();
            if (lowerHtml.includes('record not found') || lowerHtml.includes('no search result') || lowerHtml.includes('invalid cnr')) {
                await page.close();
                return {
                    success: true,
                    data: { status: 'Record Not Found', message: 'The website returned no records for this CNR.' },
                    html: resultHtml
                };
            }

            const hasTable = await page.$('#cnrno_search_result table');
            if (hasTable) {
                const parseResult = parseHtml(resultHtml);
                await page.close();
                return {
                    success: true,
                    data: parseResult.data,
                    html: resultHtml
                };
            }

            throw new Error('No data found (Retry)');

        } catch (error) {
            console.log(`[Scraper] Retry (${error.message})`);
            if (page) await page.close().catch(() => { });
            // Do NOT close browser/context
        }
    }
}

function parseHtml(html) {
    const $ = cheerio.load(html);
    const data = {};

    const clean = (text) => text ? text.replace(/\s+/g, ' ').trim() : '';
    const cleanKey = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

    const getBasicDetails = () => {
        const details = {};
        $('.table_caseno_search tr').each((i, row) => {
            $(row).find('th').each((j, th) => {
                const key = clean($(th).text());
                const val = clean($(th).next('td').text());
                if (key && val) {
                    details[cleanKey(key)] = val;
                }
            });
        });
        return details;
    };

    const basicInfo = getBasicDetails();
    Object.assign(data, basicInfo);

    const getTextByLabel = (label) => {
        let text = '';
        $('th').each((i, el) => {
            if ($(el).text().trim().includes(label)) {
                text = $(el).next('td').text();
            }
        });
        return clean(text);
    };

    data.petitioner_details = getTextByLabel('Petitioner Details');
    data.respondent_details = getTextByLabel('Respondent Details');
    data.petitioner_counsel = getTextByLabel('Petitioner Counsel');
    data.respondent_counsel = getTextByLabel('Respondent Counsel');

    const lowerCourt = [];
    const lowerCourtTable = $('h4:contains("Lower Court Details")').next('table');
    lowerCourtTable.find('tbody tr').each((i, row) => {
        if ($(row).find('th').length > 0) return;
        const cols = $(row).find('td');
        if (cols.length >= 4) {
            lowerCourt.push({
                sl_no: clean($(cols[0]).text()),
                lower_case_no: clean($(cols[1]).text()),
                court_name: clean($(cols[2]).text()),
                order_date: clean($(cols[3]).text())
            });
        }
    });
    data.lower_court_details = lowerCourt;

    const applications = [];
    const appTable = $('h4:contains("Applications Details")').next('table');
    appTable.find('tbody tr').each((i, row) => {
        if ($(row).attr('style')?.includes('font-weight: bold')) return;
        const cols = $(row).find('td');
        if (cols.length >= 4) {
            applications.push({
                ia_no: clean($(cols[0]).text()),
                prayer: clean($(cols[1]).text()),
                filing_date: clean($(cols[2]).text()),
                party: clean($(cols[3]).text())
            });
        }
    });
    data.applications = applications;

    const connected = [];
    const connTable = $('h4:contains("Connected Matters")').next('table');
    connTable.find('tbody tr').each((i, row) => {
        const text = clean($(row).text());
        if (text.toLowerCase().includes('no records')) return;
        const cols = $(row).find('td');
        if (cols.length >= 2) {
            connected.push({
                case_no: clean($(cols[0]).text()),
                stage: clean($(cols[1]).text()),
            });
        }
    });
    data.connected_matters = connected;

    data.main_prayer = getTextByLabel('Prayer');

    const history = [];
    const histTable = $('h4:contains("History of Case Hearing")').next('table');
    histTable.find('tbody tr').each((i, row) => {
        const cols = $(row).find('td');
        if (cols.length >= 7) {
            history.push({
                judge: clean($(cols[0]).text()),
                item_no: clean($(cols[1]).text()),
                business_date: clean($(cols[2]).text()),
                business: clean($(cols[3]).text()),
                hearing_date: clean($(cols[4]).text()),
                purpose: clean($(cols[5]).text()),
                adjournment: clean($(cols[6]).text())
            });
        } else {
            let entry = {};
            $(row).find('th').each((j, th) => {
                const k = cleanKey($(th).text());
                const v = clean($(th).next('td').text());
                if (k) entry[k] = v;
            });
            if (Object.keys(entry).length > 0) history.push(entry);
        }
    });
    data.case_history = history;

    const caveats = [];
    const cavTable = $('h4:contains("Caveat Details")').next('table');
    cavTable.find('tbody tr').each((i, row) => {
        if ($(row).text().includes('No records')) return;
        const cols = $(row).find('td');
        if (cols.length >= 7) {
            caveats.push({
                sl_no: clean($(cols[0]).text()),
                filing_no: clean($(cols[1]).text()),
                caveat_no: clean($(cols[2]).text()),
                petitioner: clean($(cols[3]).text()),
                respondent: clean($(cols[4]).text()),
                counsel: clean($(cols[5]).text()),
                filing_date: clean($(cols[6]).text())
            });
        }
    });
    data.caveat_details = caveats;

    const orders = [];
    const ordTable = $('h4:contains("Orders")').next('table');
    ordTable.find('tbody tr').each((i, row) => {
        if ($(row).text().includes('No records')) return;
        const cols = $(row).find('td');
        if (cols.length >= 7) {
            const links = [];
            $(cols[6]).find('a').each((j, a) => {
                links.push({
                    text: clean($(a).text()),
                    href: $(a).attr('href')
                });
            });

            orders.push({
                sl_no: clean($(cols[0]).text()),
                case_details: clean($(cols[1]).text()),
                petitioner: clean($(cols[2]).text()),
                respondent: clean($(cols[3]).text()),
                order_date: clean($(cols[4]).text()),
                judge: clean($(cols[5]).text()),
                order_copy: links
            });
        }
    });
    data.orders = orders;

    return { data };
}

module.exports = { scrapeStatus };
