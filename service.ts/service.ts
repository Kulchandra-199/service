// docker run -d --name redis -p 6379:6379 redis
/**
 * Imports from Crawlee and Node.js URL module
 */
import {
  enqueueLinks,
  Configuration,
  PlaywrightCrawler,
  ProxyConfiguration,
} from "crawlee";
import { createPlaywrightRouter, Dataset } from "crawlee";
import { URL } from "url";
import { RequestQueue } from "crawlee";
// ES6+ example
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import "dotenv/config";

/**
 * Types for the configuration of the EcommerceCrawler
 */
export interface CrawlerConfig {
  /** Array of initial URLs to start the crawl from */
  startUrls: string[];
  // /** Array of regex patterns to identify listing pages */
  productListingUrlPatterns: string[];
  // /** Array of regex patterns to identify product cards */
  productCardSelectors: string;
  /** Array of regex patterns to identify product pages */
  productUrlPatterns: string[];
  /** CSS selectors for pagination links */
  paginationSelectors: string;
  /** CSS selectors for product links */
  productLinkSelectors: string[];
  /** Optional maximum number of pages to process */
  maxPages?: number;
  nameSelector: string;
  priceSelector: string;
}

/**
 * Helper function to check if a given URL matches any product URL pattern
 * @param {string} url - The URL to check
 * @param {string[]} patterns - Array of regex patterns
 * @returns {boolean} - True if the URL matches any pattern
 */
const isProductUrl = (url: string, patterns: string[]): boolean => {
  return patterns.some((pattern) => {
    const regex = createRegexFromUrl(pattern);
    return regex.test(url);
  });
};
const createRegexFromUrl = (url: string) => {
  // Parse the URL
  const urlParts = new URL(url);

  // Create a regex that matches the domain
  return new RegExp(
    `^https?://[\\w-]+\\.${urlParts.hostname.split(".").slice(1).join("\\.")}`,
    "i"
  );
};

const isListingUrl = (url: string, patterns: string[]): boolean => {
  return patterns.some((pattern) => {
    const regex = createRegexFromUrl(pattern);
    return regex.test(url);
  });
  //const regex = createRegexFromUrl(patterns);
  // return regex.test(url);
};

/**
 * Helper function to extract the domain name from a URL
 * @param {string} url - The URL to parse
 * @returns {string} - The domain name
 */
const getDomain = (url: string): string => {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname;
  } catch (error) {
    return "";
  }
};

/**
 * Helper function to normalize URLs relative to a base URL
 * @param {string} url - The URL to normalize
 * @param {string} baseUrl - The base URL
 * @returns {string} - The normalized absolute URL
 */
const normalizeUrl = (url: string, baseUrl: string): string => {
  try {
    return new URL(url, baseUrl).href;
  } catch (error) {
    return "";
  }
};

/**
 * A class to manage e-commerce web scraping using Crawlee
 */
export class EcommerceCrawler {
  /** Configuration object for the crawler */
  private config: CrawlerConfig;
  /** Set to track processed URLs */
  private processedUrls: Set<string> = new Set();
  /** Counter to track the number of pages processed */
  private pageCount: number = 0;

  /**
   * Constructor to initialize the crawler
   * @param {CrawlerConfig} config - Configuration object
   */
  constructor(config: CrawlerConfig) {
    this.config = {
      maxPages: 1000, // Default maximum pages
      ...config,
    };
  }

  /**
   * Main function to run the crawler
   */
  async run() {
    const router = createPlaywrightRouter();
    const requestQueue = await RequestQueue.open();

    /**
     * Default route handler for category or listing pages
     */
    router.addDefaultHandler(async ({ request, enqueueLinks, log }) => {
      const baseUrl = request.loadedUrl;
      if (!baseUrl) return;

      await enqueueLinks({
        limit: 100,
        transformRequestFunction: (req) => {
          const url = normalizeUrl(req.url, baseUrl);
          if (
            !this.processedUrls.has(url) &&
            isListingUrl(url, this.config.productListingUrlPatterns)
          ) {
            this.processedUrls.add(url);
            return req;
          }
          return false;
        },
        label: "listing",
      });
    });

    router.addHandler(
      "listing",
      async ({ request, page, log, enqueueLinks }) => {
        try {
          log.info(`Processing URL: ${request.loadedUrl}`);

          // // Existing product extraction logic...
          const productCardSelector = this.config.productCardSelectors;

          // Wait for product card selector to be available
          await page.waitForSelector(productCardSelector, {
            state: "attached",
            timeout: 10000,
          });

          // Extract product details
          const products = await page.evaluate((selector) => {
            const productCards = document.querySelectorAll(selector);
            return Array.from(productCards)
              .map((card) => {
                const linkElement = card.querySelector("a[href]");
                return linkElement ? linkElement.getAttribute("href") : null;
              })
              .filter((href): href is string => href !== null);
          }, productCardSelector);

          //  Enqueue the product URLs
          if (products.length > 0) {
            await enqueueLinks({
              limit: 1,
              urls: products,
              label: "product",
              requestQueue,
            });

            log.info(`Extracted ${products.length} product URLs`);
          }

          // Pagination logic
          const paginationSelector = this.config.paginationSelectors;
          const nextButton = await page.locator(paginationSelector);

          // TODO - check if the next button is blocked
          // const isClickBlocked = async (element) => {
          //   const boundingBox = await element.boundingBox();
          //   if (!boundingBox) {
          //     return true; // If no bounding box, the element is not visible or disabled
          //   }

          //   const isOverlaid = await page.evaluate((boundingBox) => {
          //     const elements = document.elementsFromPoint(
          //       boundingBox.x + boundingBox.width / 2,
          //       boundingBox.y + boundingBox.height / 2,
          //     );
          //     return elements.some((elem) => elem !== document.documentElement && elem !== boundingBox);
          //   }, boundingBox);

          //   return isOverlaid; // Return true if overlaid, false if not
          // };
          // let is_blocked = await isClickBlocked(nextButton);
          // if (is_blocked) {
          //        await clickAcceptButton();
          //   is_blocked = await isClickBlocked(nextButton);
          // }

          const clickAcceptButton = async () => {
            const acceptButton = page.locator("#AcceptAll"); // Adjust this selector based on your page
            await page.waitForLoadState("networkidle"); // Waits for no network connections for at least 500 ms
            await page.evaluate(() => {
              const overlay = document.getElementById("cbOvlry");
              if (overlay) {
                overlay.remove(); // Remove the overlay element from the DOM
              }
            });

            // Wait for the element to be visible and stable
            await acceptButton.waitFor({ state: "attached" }); // Ensures the element is in the DOM
            await acceptButton.waitFor({ state: "visible" }); // Ensures the element is visible
            if (!acceptButton) return;
            // Optional: Ensure the element is not moving or animating
            //   await acceptButton.waitFor({ state: 'stable' });

            // Scroll into view if necessary and click the button
            await acceptButton.scrollIntoViewIfNeeded();

            await acceptButton.first().click();
          };
          await clickAcceptButton();
          // Check if next button exists
          if ((await nextButton.count()) > 0) {
            try {
              await nextButton.first().click();

              // Wait for the page to load
              await page.waitForSelector(productCardSelector, {
                state: "attached",
                timeout: 10000,
              });

              log.info(`Navigated to next page`);

              // Add the current page back to the queue with high priority
              await requestQueue.addRequest({
                url: page.url(),
                label: "listing",
                uniqueKey: page.url(),
                priority: 1,
              });
            } catch (paginationError) {
              log.error(`Pagination error: ${paginationError.message}`);
            }
          } else {
            log.info("No more pages to process");
          }
        } catch (error) {
          log.error(
            `Error while processing URL ${request.loadedUrl}: ${error.message}`
          );
        }
      }
    );

    // Optional: Product page handler
    router.addHandler("product", async ({ request, page, log }) => {
      try {
        log.info(`Processing product URL: ${request.loadedUrl}`);

        // Create S3 client with configuration
        // const s3Client = new S3Client({
        //   region: process.env.AWS_REGION || 'us-east-1', // Specify your AWS region
        //   credentials: {
        //     accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        //     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        //   },
        // });

        // Get the page HTML content
        const product_html = await page.content();

        //  let name = await page.locator('//*[@id="__layout"]/div/main/div/div[3]/div[1]/div/div[1]/h1');

        // Dynamically fetch the name and price using config selectors
        const nameSelector = this.config.nameSelector;
        const priceSelector = this.config.priceSelector;

        // Extract product name using the config selector
        let name = await page.locator(nameSelector);
        const productName = await name.textContent();
        console.log("Product Name:", productName);

        // Extract price using the config selector
        const priceElement = await page.locator(priceSelector).first();
        const price = await priceElement.textContent();
        console.log("Price:", price);
        const eanLabelLocator = await page.locator("body").locator("text=EAN");

        // Check if the "EAN" text exists
        if ((await eanLabelLocator.count()) > 0) {
          // Find the parent element (tr or other container) and extract the associated number
          const eanValueLocator = await eanLabelLocator.locator(
            "xpath=following-sibling::td | ancestor::tr//td"
          );

          // Get the EAN number associated with it
          const eanValue = await eanValueLocator.textContent();
          console.log("EAN Value:", eanValue?.trim());
        } else {
          throw new Error("EAN label not found on the page");
        }

        // let eanSelector = this.config.eanSelector;

        // Generate a unique filename
        const filename = `products/${new Date().toISOString()}_${generateUniqueId()}.html`;

        // if (!request.loadedUrl)
        // // Prepare S3 upload parameters
        // const params = {
        //   Bucket: process.env.S3_BUCKET_NAME!, // Your S3 bucket name from environment variable
        //   Key: filename,
        //   Body: product_html,
        //   ContentType: 'text/html',
        // };

        try {
          // Upload HTML to S3
          //      const command = new PutObjectCommand(params);
          // const response = await s3Client.send(command);

          log.info(`Product HTML uploaded to S3: ${filename}`);

          // Optionally, you can save metadata about the upload
          // await Dataset.pushData({
          //   url: request.loadedUrl,
          //   s3Path: filename,
          //   uploadTimestamp: new Date().toISOString()
          // });
        } catch (s3Error) {
          log.error(
            `S3 Upload Error for ${request.loadedUrl}: ${s3Error.message}`
          );
        }
      } catch (error) {
        log.error(
          `Error processing product ${request.loadedUrl}: ${error.message}`
        );
      }
    });

    // Utility function to generate a unique ID
    function generateUniqueId() {
      return (
        Math.random().toString(36).substring(2, 15) +
        Math.random().toString(36).substring(2, 15)
      );
    }

    // TODO process.env

    const config = Configuration.getGlobalConfig();
    config.set("persistStateIntervalMillis", 10_000);
    config.set("purgeOnStart", true);
    // config.set('',);

    // Create and configure the PlaywrightCrawler
    const crawler = new PlaywrightCrawler({
      // headless: false,
      requestHandler: router,
      maxRequestsPerCrawl: this.config.maxPages! * 2, // Account for product & category pages
      maxConcurrency: 10,
    });

    // Start the crawl
    await crawler.run(this.config.startUrls);

    // Open the dataset for further processing
    return Dataset.open();
  }

  // Utility method to generate a unique crawler ID
  async crawleeId(id?: number) {
    if (id) return id;
    return new Date().getTime();
  }
}

// {
//   "startUrls": ["https://www.bouwmaat.nl/"],
//   "productListingUrlPatterns": [
//     "https://www.bouwmaat.nl/bouwmaterialen/droge-afbouw/metalen-profielen"
//   ],
//   "productUrlPatterns": ["/buy/", "/p/", "/item/", "products?id="],
//   "productCardSelectors": ".group.relative.rounded.shadow.px-3.py-6.bg-white.flex.flex-col.text-sm.hover\\:shadow-lg.md\\:px-6",
//   "productLinkSelectors": [
//     "a[href*=\"/product/\"]",
//     "a[href*=\"/p/\"]",
//     ".product-card a",
//     ".product-link"
//   ],
//   "paginationSelectors": "//*[@id='product-lister-result']/div[4]/div/ul/li[8]/button",
//   "nameSelector": "//*[@id='__layout']/div/main/div/div[3]/div[1]/div/div[1]/h1",
//   "priceSelector": "//*[@id='__layout']/div/main/div/div[3]/div[1]/div/div[3]/div[2]/div[1]/div/div/p/span[1]/span",
//   "maxPages": 100
// }

// {
//   "startUrls": ["https://www.elektramat.nl"],
//   "productListingUrlPatterns": [
//     "https://www.elektramat.nl/installatiemateriaal/aardingsmateriaal/badkameraardingsrail/"
//   ],
//   "productUrlPatterns": ["/buy/", "/p/", "/item/", "products?id="],
//   "productCardSelectors": ".product-item",
//   "productLinkSelectors": [
//     "a[href*=\"/product/\"]",
//     "a[href*=\"/p/\"]",
//     ".product-card a",
//     ".product-link"
//   ],
//   "paginationSelectors": "//*[@id='maincontent']/div[4]/div[2]/section/div[3]/div/nav/ol/a",
//   "nameSelector": "//*[@id='maincontent']/div[3]/div/div[1]/div[2]/section/div[2]/div/strong",
//   "priceSelector": "//*[@id='product-main-price']/div/div[1]/div[1]/span/span[1]",
//   "maxPages": 100
// }
