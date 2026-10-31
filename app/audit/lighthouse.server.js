// Lighthouse run in the app's own headless Chrome, for password-protected
// storefronts that Google PageSpeed Insights cannot open.
//
// The storefront is unlocked first with the password the merchant typed for this
// run (see unlockStorefront in engine.server.js). Only the resulting session
// cookies reach Chrome, set for the shop's own host, so they are never sent to
// third-party script hosts. Neither the password nor the cookies are stored,
// logged or returned in the report.
//
// Needs Chrome or Chromium on the server: chrome-launcher finds an installed one,
// or set CHROME_PATH. Without it the check is reported as not measured.

import { CHECK_STATUS } from "./storefrontClient.server";
import { LIGHTHOUSE_SOURCES, parsePagespeed, readPagespeedConfig } from "./pagespeed.server";

const CATEGORIES = ["performance", "accessibility", "best-practices"];
const LOCAL_TIMEOUT_MS = 120_000; // Chrome start-up plus one full Lighthouse run

/** Parses a "name=value; name2=value2" cookie header into pairs. */
export function cookiePairs(header) {
  return String(header || "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.includes("="))
    .map((p) => ({ name: p.slice(0, p.indexOf("=")), value: p.slice(p.indexOf("=") + 1) }))
    .filter((c) => /^[\w.-]{1,100}$/.test(c.name));
}

async function runLighthouse({ url, cookies, strategy }) {
  const [{ default: lighthouse }, chromeLauncher, { default: puppeteer }] = await Promise.all([
    import("lighthouse"),
    import("chrome-launcher"),
    import("puppeteer-core"),
  ]);
  const config = strategy === "DESKTOP" ? (await import("lighthouse/core/config/desktop-config.js")).default : undefined;
  const flags = ["--headless=new", "--disable-gpu", "--disable-dev-shm-usage"];
  // Chrome refuses to start its sandbox as root (typical in Docker).
  if (typeof process.getuid === "function" && process.getuid() === 0) flags.push("--no-sandbox");
  const chrome = await chromeLauncher.launch({ chromeFlags: flags, logLevel: "silent" });
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
    const page = await browser.newPage();
    if (cookies.length) await page.setCookie(...cookies.map((c) => ({ ...c, url, secure: true, httpOnly: true })));
    const result = await lighthouse(
      url,
      { port: chrome.port, output: "json", logLevel: "silent", onlyCategories: CATEGORIES, disableStorageReset: true },
      config,
      page,
    );
    return result?.lhr;
  } finally {
    await browser?.disconnect().catch(() => {});
    await Promise.resolve(chrome.kill()).catch(() => {});
  }
}

/** Measures the homepage locally. Never throws: failures come back as a status. */
export async function measureHomepageLocally({ url, cookieHeader, env = process.env, runImpl = runLighthouse }) {
  const { strategy } = readPagespeedConfig(env);
  const cookies = cookiePairs(cookieHeader);
  let timer;
  let lhr;
  try {
    lhr = await Promise.race([
      runImpl({ url, cookies, strategy }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), LOCAL_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    if (err?.name === "TimeoutError") return { status: CHECK_STATUS.ERROR, message: "The local Lighthouse run did not finish in time.", findings: [] };
    const noChrome = /chrome|chromium|ERR_MODULE_NOT_FOUND|Cannot find (module|package)/i.test(`${err?.code || ""} ${err?.message || ""}`);
    return {
      status: CHECK_STATUS.NOT_MEASURED,
      message: noChrome
        ? "Not measured: the store is password protected and Google cannot log in to it, and Chrome is not available on the app server for a local Lighthouse run (install Chrome or set CHROME_PATH)."
        : "Not measured: the local Lighthouse run of the unlocked storefront failed.",
      findings: [],
    };
  } finally {
    clearTimeout(timer);
  }
  return parsePagespeed({ lighthouseResult: lhr }, { requestedUrl: url, strategy, source: LIGHTHOUSE_SOURCES.local });
}
