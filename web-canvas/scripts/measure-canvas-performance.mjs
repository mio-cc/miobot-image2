import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

async function main() {
const targetUrl = process.argv[2] ?? process.env.CANVAS_PERF_URL ?? "http://localhost:5173";
const browserPath = process.env.CHROME_PATH ?? findBrowserPath();
const remotePort = Number.parseInt(process.env.CANVAS_PERF_CDP_PORT ?? "9229", 10);

if (!browserPath) {
  throw new Error("Could not find Chrome or Edge. Set CHROME_PATH to a Chromium-compatible browser.");
}

const profileDir = mkdtempSync(join(tmpdir(), "miobot-canvas-chrome-"));
let browserProcess;

try {
  stage("launch-browser");
  browserProcess = spawn(browserPath, [
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${profileDir}`,
    "--headless=new",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-popup-blocking",
    "--disable-renderer-backgrounding",
    "--hide-scrollbars",
    "--no-first-run",
    "--window-size=1440,1100",
    "about:blank"
  ], {
    stdio: "ignore"
  });

  stage("create-target");
  const target = await createTarget(remotePort, targetUrl);
  stage("connect-cdp");
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  const network = new NetworkLog();
  client.on("Network.responseReceived", (params) => network.responseReceived(params));
  client.on("Network.loadingFinished", (params) => network.loadingFinished(params));
  client.on("Network.loadingFailed", (params) => network.loadingFailed(params));

  stage("enable-cdp-domains");
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Network.enable");
  await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  await client.send("Performance.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false
  });
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__canvasPerfLongTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__canvasPerfLongTasks.push({
              name: entry.name,
              startTime: entry.startTime,
              duration: entry.duration
            });
          }
        }).observe({ type: "longtask", buffered: true });
      } catch {}
    `
  });

  stage("navigate");
  const navStartedAt = Date.now();
  await client.send("Page.navigate", { url: targetUrl });
  await waitForPageLoad(client, 20_000);
  stage("wait-gallery");
  const galleryReadyMs = await waitForCondition(client, "Boolean(document.querySelector('.gallery-pane'))", 15_000);
  const contentReadyMs = await waitForCondition(
    client,
    "Boolean(document.querySelector('.masonry-gallery, .empty-gallery')) && !document.querySelector('.gallery-skeleton')",
    20_000
  );
  await sleep(700);

  stage("snapshot");
  const firstSnapshot = await evaluateValue(client, pageSnapshotExpression());
  stage("wheel-down");
  const wheelDown = await wheelProfile(client, 1);
  stage("wheel-up");
  const wheelUp = await wheelProfile(client, -1);
  stage("final-metrics");
  const finalSnapshot = await evaluateValue(client, pageSnapshotExpression());
  const perf = await evaluateValue(client, performanceExpression());
  const cdpMetrics = await client.send("Performance.getMetrics").then((result) => summarizeCdpMetrics(result.metrics ?? []));

  await client.close();

  const result = {
    url: targetUrl,
    browser: browserPath,
    measuredAt: new Date().toISOString(),
    wallTimeToLoadEventMs: Date.now() - navStartedAt,
    galleryReadyMs,
    contentReadyMs,
    navigation: perf.navigation,
    resources: perf.resources,
    longTasks: perf.longTasks,
    cdpMetrics,
    network: network.summary(),
    firstSnapshot,
    wheelDown,
    wheelUp,
    finalSnapshot
  };

  console.log(JSON.stringify(result, null, 2));
} finally {
  if (browserProcess && !browserProcess.killed) {
    browserProcess.kill();
    await Promise.race([
      new Promise((resolve) => browserProcess.once("exit", resolve)),
      sleep(3000)
    ]);
  }
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
}

function stage(name) {
  console.error(`[canvas-perf] ${name}`);
}

function findBrowserPath() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function createTarget(port, url) {
  await waitForJson(port, "/json/version", 10_000);
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Could not create browser target: HTTP ${response.status}`);
  }
  return response.json();
}

async function waitForJson(port, path, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(120);
  }
  throw new Error(`Timed out waiting for Chrome DevTools on port ${port}: ${lastError?.message ?? "unknown error"}`);
}

async function waitForPageLoad(client, timeoutMs) {
  const loaded = new Promise((resolve) => {
    client.once("Page.loadEventFired", resolve);
  });
  await Promise.race([
    loaded,
    sleep(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for Page.loadEventFired after ${timeoutMs}ms`);
    })
  ]);
}

async function waitForCondition(client, condition, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await evaluateValue(client, `(() => {
      if (${condition}) return performance.now();
      return false;
    })()`);
    if (value) return Math.round(value);
    await sleep(100);
  }
  throw new Error(`Timed out waiting for condition: ${condition}`);
}

async function evaluateValue(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? "Runtime.evaluate failed");
  }
  return response.result.value;
}

async function wheelProfile(client, direction) {
  const result = await evaluateValue(client, scrollSimulationExpression(2600, direction));
  if (!result) throw new Error("Wheel profile did not produce a frame result.");
  return {
    direction: direction > 0 ? "down" : "up",
    ...result
  };
}

function scrollSimulationExpression(durationMs, direction) {
  return `(() => new Promise((resolve) => {
    const pane = document.querySelector('.gallery-pane') || document.scrollingElement;
    const startTop = pane.scrollTop;
    const maxScrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight);
    const requestedDistance = Math.min(9000, Math.max(1200, pane.clientHeight * 3));
    const signedDistance = ${direction} > 0
      ? Math.min(requestedDistance, maxScrollTop - startTop)
      : -Math.min(requestedDistance, startTop);
    const frames = [];
    let previous = performance.now();
    const started = previous;
    let maxDelta = 0;
    let over16 = 0;
    let over33 = 0;
    let count = 0;
    const tick = (now) => {
      const delta = now - previous;
      previous = now;
      if (count > 0) {
        frames.push(delta);
        maxDelta = Math.max(maxDelta, delta);
        if (delta > 16.7) over16 += 1;
        if (delta > 33.4) over33 += 1;
      }
      count += 1;
      if (now - started < ${durationMs}) {
        const progress = Math.min(1, (now - started) / ${durationMs});
        const eased = 1 - Math.pow(1 - progress, 3);
        pane.scrollTop = startTop + signedDistance * eased;
        requestAnimationFrame(tick);
      } else {
        pane.scrollTop = startTop + signedDistance;
        frames.sort((a, b) => a - b);
        const sum = frames.reduce((total, value) => total + value, 0);
        const percentile = (p) => frames.length ? frames[Math.min(frames.length - 1, Math.floor((frames.length - 1) * p))] : 0;
        resolve({
          durationMs: Math.round(now - started),
          frameCount: frames.length,
          avgFrameMs: Number((sum / Math.max(1, frames.length)).toFixed(2)),
          p95FrameMs: Number(percentile(0.95).toFixed(2)),
          maxFrameMs: Number(maxDelta.toFixed(2)),
          over16FramePct: Number((over16 / Math.max(1, frames.length) * 100).toFixed(2)),
          over33FramePct: Number((over33 / Math.max(1, frames.length) * 100).toFixed(2)),
          startTop,
          endTop: pane.scrollTop,
          scrollDelta: Math.round(pane.scrollTop - startTop),
          scrollHeight: pane.scrollHeight,
          clientHeight: pane.clientHeight
        });
      }
    };
    requestAnimationFrame(tick);
  }))()`;
}

function pageSnapshotExpression() {
  return `(() => {
    const pane = document.querySelector('.gallery-pane');
    const cards = Array.from(document.querySelectorAll('.masonry-card'));
    const images = Array.from(document.querySelectorAll('.masonry-card img'));
    return {
      activeTab: document.querySelector('.canvas-workspace')?.getAttribute('data-active-tab') ?? null,
      cards: cards.length,
      completeImages: images.filter((image) => image.complete).length,
      imageElements: images.length,
      scrollHeight: pane?.scrollHeight ?? 0,
      clientHeight: pane?.clientHeight ?? 0,
      backTopVisible: document.querySelector('.canvas-back-top')?.getAttribute('data-visible') ?? null,
      bodyTextLength: document.body.innerText.length
    };
  })()`;
}

function performanceExpression() {
  return `(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const apiResources = resources.filter((entry) => entry.name.includes('/canvas-api/'));
    const imageResources = resources.filter((entry) => /\\/canvas-api\\/assets\\/.+\\/(preview|download)/.test(entry.name));
    const summarize = (entries) => ({
      count: entries.length,
      totalDurationMs: Math.round(entries.reduce((total, entry) => total + entry.duration, 0)),
      maxDurationMs: Math.round(entries.reduce((max, entry) => Math.max(max, entry.duration), 0)),
      totalTransferKb: Math.round(entries.reduce((total, entry) => total + (entry.transferSize || 0), 0) / 1024)
    });
    const longTasks = window.__canvasPerfLongTasks || [];
    return {
      navigation: nav ? {
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        loadEventMs: Math.round(nav.loadEventEnd),
        responseEndMs: Math.round(nav.responseEnd),
        transferKb: Math.round((nav.transferSize || 0) / 1024),
        encodedKb: Math.round((nav.encodedBodySize || 0) / 1024)
      } : null,
      resources: {
        api: summarize(apiResources),
        previewImages: summarize(imageResources),
        all: summarize(resources)
      },
      longTasks: {
        count: longTasks.length,
        totalMs: Math.round(longTasks.reduce((total, entry) => total + entry.duration, 0)),
        maxMs: Math.round(longTasks.reduce((max, entry) => Math.max(max, entry.duration), 0))
      }
    };
  })()`;
}

function summarizeCdpMetrics(metrics) {
  const byName = new Map(metrics.map((metric) => [metric.name, metric.value]));
  return {
    jsHeapUsedMb: round((byName.get("JSHeapUsedSize") ?? 0) / 1024 / 1024, 2),
    jsHeapTotalMb: round((byName.get("JSHeapTotalSize") ?? 0) / 1024 / 1024, 2),
    nodes: byName.get("Nodes") ?? 0,
    layoutCount: byName.get("LayoutCount") ?? 0,
    recalcStyleCount: byName.get("RecalcStyleCount") ?? 0,
    layoutDurationMs: round((byName.get("LayoutDuration") ?? 0) * 1000, 2),
    recalcStyleDurationMs: round((byName.get("RecalcStyleDuration") ?? 0) * 1000, 2),
    scriptDurationMs: round((byName.get("ScriptDuration") ?? 0) * 1000, 2)
  };
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

class NetworkLog {
  #requests = new Map();

  responseReceived(params) {
    const request = this.#requests.get(params.requestId) ?? {};
    request.url = params.response.url;
    request.status = params.response.status;
    request.mimeType = params.response.mimeType;
    request.encodedDataLength = params.response.encodedDataLength ?? 0;
    this.#requests.set(params.requestId, request);
  }

  loadingFinished(params) {
    const request = this.#requests.get(params.requestId) ?? {};
    request.encodedDataLength = params.encodedDataLength ?? request.encodedDataLength ?? 0;
    request.failed = false;
    this.#requests.set(params.requestId, request);
  }

  loadingFailed(params) {
    const request = this.#requests.get(params.requestId) ?? {};
    request.failed = true;
    request.errorText = params.errorText;
    this.#requests.set(params.requestId, request);
  }

  summary() {
    const requests = Array.from(this.#requests.values()).filter((request) => request.url);
    const api = requests.filter((request) => request.url.includes("/canvas-api/"));
    const previews = requests.filter((request) => /\/canvas-api\/assets\/.+\/(preview|download)/.test(request.url));
    return {
      requests: requests.length,
      failed: requests.filter((request) => request.failed || request.status >= 400).length,
      apiRequests: api.length,
      previewRequests: previews.length,
      transferredKb: Math.round(requests.reduce((total, request) => total + (request.encodedDataLength || 0), 0) / 1024),
      apiTransferredKb: Math.round(api.reduce((total, request) => total + (request.encodedDataLength || 0), 0) / 1024)
    };
  }
}

class CdpClient {
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #onceListeners = new Map();

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new CdpClient(ws);
      ws.addEventListener("open", () => resolve(client), { once: true });
      ws.addEventListener("error", reject, { once: true });
      ws.addEventListener("message", (event) => client.#handleMessage(event));
      ws.addEventListener("close", () => client.#rejectPending(new Error("CDP socket closed")));
    });
  }

  constructor(ws) {
    this.ws = ws;
  }

  send(method, params = {}) {
    const id = this.#nextId;
    this.#nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 15_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  on(eventName, listener) {
    const listeners = this.#listeners.get(eventName) ?? [];
    listeners.push(listener);
    this.#listeners.set(eventName, listeners);
  }

  once(eventName, listener) {
    const listeners = this.#onceListeners.get(eventName) ?? [];
    listeners.push(listener);
    this.#onceListeners.set(eventName, listeners);
  }

  close() {
    this.ws.close();
  }

  #handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    const listeners = this.#listeners.get(message.method) ?? [];
    for (const listener of listeners) listener(message.params ?? {});

    const onceListeners = this.#onceListeners.get(message.method) ?? [];
    if (onceListeners.length) {
      this.#onceListeners.delete(message.method);
      for (const listener of onceListeners) listener(message.params ?? {});
    }
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
