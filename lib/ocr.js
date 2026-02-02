const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');

// Ensure Tesseract uses local data if possible or downloads to a specific cache
// For Vercel/Serverless, we might need more config, but for local Next.js:
const workerConfig = {
    langPath: path.join(process.cwd(), 'lib'), // Point to where we stick eng.traineddata
    gzip: false,
    cachePath: path.join(process.cwd(), 'lib')
};

/**
 * Solves the CAPTCHA image buffer using Tesseract.js
 * @param {Buffer} imageBuffer - The image buffer from Playwright
 * @returns {Promise<string>} - The solved text
 */
// Singleton worker instance
let worker = null;

async function initWorker() {
    if (!worker) {
        worker = await Tesseract.createWorker('eng', 1, {
            ...workerConfig,
            logger: m => process.env.DEBUG_OCR ? console.log(m) : null
        });
        await worker.setParameters({
            tessedit_char_whitelist: '0123456789',
        });
    }
    return worker;
}

/**
 * Solves the CAPTCHA image buffer using Tesseract.js
 * @param {Buffer} imageBuffer - The image buffer from Playwright
 * @returns {Promise<string>} - The solved text
 */
async function solveCaptcha(imageBuffer) {
    try {
        const w = await initWorker();

        // Preprocess image with Sharp
        const processedImage = await sharp(imageBuffer)
            .resize({ height: 100 })
            .grayscale()
            .threshold(128, { grayscale: false })
            .median(1)
            .toBuffer();

        // Recognize using the persistent worker
        const { data: { text } } = await w.recognize(processedImage);

        return text.trim().replace(/[^0-9]/g, '');
    } catch (error) {
        console.error('OCR Error:', error);
        return null;
    }
}

module.exports = { solveCaptcha };
