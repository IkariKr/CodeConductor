import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');
const rendererRoot = path.join(workspaceRoot, '.webpack', 'renderer');
const mainEntry = path.join(workspaceRoot, '.webpack', 'main', 'index.js');
const port = 3100;

const samplePromptFile = JSON.stringify({
  chunkedPrompt: {
    chunks: [
      { text: 'first task', role: 'user', tokenCount: 10 },
      { text: 'thought', role: 'model', tokenCount: 10, isThought: true },
      { text: 'second task', role: 'user', tokenCount: 10 },
      { text: 'third task', role: 'user', tokenCount: 10 },
    ],
  },
});

const ensureCompiledAssets = () => {
  const requiredFiles = [path.join(rendererRoot, 'main_window', 'index.js'), path.join(mainEntry)];
  for (const filePath of requiredFiles) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing compiled asset: ${filePath}. Run npm start once to refresh .webpack before executing this smoke script.`);
    }
  }
};

const contentType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json' || ext === '.map') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
};

const createStaticServer = () =>
  createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const safeRelative = rawPath === '/' ? 'main_window/index.html' : rawPath.replace(/^\/+/, '');
    const target = path.resolve(rendererRoot, safeRelative);

    if (!target.startsWith(rendererRoot + path.sep) && target !== rendererRoot) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    fs.stat(target, (statError, stat) => {
      if (statError) {
        res.writeHead(404);
        res.end('not found');
        return;
      }

      const resolvedPath = stat.isDirectory() ? path.join(target, 'index.html') : target;
      fs.readFile(resolvedPath, (readError, buffer) => {
        if (readError) {
          res.writeHead(404);
          res.end('not found');
          return;
        }

        res.writeHead(200, { 'Content-Type': contentType(resolvedPath) });
        res.end(buffer);
      });
    });
  });

const startServer = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });

const stopServer = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getMainWindow = (app) => app.windows().find((page) => !page.url().startsWith('devtools://'));

const readPageState = async (page) => page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.getState() ?? null);

const waitForPageState = async (page, predicate, timeoutMs, label) => {
  const startedAt = Date.now();
  let lastState = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastState = await readPageState(page);
    if (lastState && predicate(lastState)) {
      return lastState;
    }
    await wait(100);
  }

  throw new Error(`Timed out waiting for ${label}. Last state: ${JSON.stringify(lastState)}`);
};

const installFakeRuntime = async (page, mode) => {
  await page.evaluate((currentMode) => {
    if (currentMode === 'resume-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: (() => {
          let compareIndex = 0;
          const changes = [
            { created: ['summary.md'], updated: [], deleted: [] },
            { created: [], updated: ['summary.md'], deleted: [] },
            { created: [], updated: [], deleted: [] },
            { created: [], updated: [], deleted: [] },
          ];

          return () => {
            const next = changes[Math.min(compareIndex, changes.length - 1)];
            compareIndex += 1;
            return next;
          };
        })(),
        startAgyPrintTurn: (() => {
          let turnIndex = 0;

          return async () => {
            const current = turnIndex++;
            let aborted = false;
            let resolvePromise;
            const promise = new Promise((resolve) => {
              resolvePromise = resolve;
              setTimeout(() => {
                resolve({
                  output: `TURN_${current + 1}`,
                  conversationId: 'conv-test-1234',
                  exitCode: aborted ? null : 0,
                  logFilePath: 'stub.log',
                  rawLog: 'stub',
                });
              }, 800);
            });

            return {
              id: `fake-${current + 1}`,
              promise,
              abort: async () => {
                aborted = true;
                resolvePromise({
                  output: '',
                  conversationId: 'conv-test-1234',
                  exitCode: null,
                  logFilePath: 'stub.log',
                  rawLog: 'stub',
                });
              },
            };
          };
        })(),
      };
      return;
    }

    window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
      snapshotDirectory: async () => ({
        stub: { path: 'stub', size: 1, lastModified: Date.now() },
      }),
      compareDirectorySnapshots: () => ({ created: [], updated: [], deleted: [] }),
      startAgyPrintTurn: (() => {
        let resolved = false;

        return async () => {
          let resolvePromise;
          const promise = new Promise((resolve) => {
            resolvePromise = resolve;
            setTimeout(() => {
              if (!resolved) {
                resolved = true;
                resolve({
                  output: 'LATE',
                  conversationId: 'conv-abort',
                  exitCode: 0,
                  logFilePath: 'stub.log',
                  rawLog: 'stub',
                });
              }
            }, 5000);
          });

          return {
            id: 'abort-turn',
            promise,
            abort: async () => {
              if (!resolved) {
                resolved = true;
                resolvePromise({
                  output: '',
                  conversationId: 'conv-abort',
                  exitCode: null,
                  logFilePath: 'stub.log',
                  rawLog: 'stub',
                });
              }
            },
          };
        };
      })(),
    };
  }, mode);
};

const seedPage = async (page) => {
  await page.evaluate((rawContent) => {
    window.__REBUILDCHAT_FILE_PICKER_OVERRIDE__ = {
      filePath: 'D:/fixtures/sample.json',
      rawContent,
      workDir: 'D:/fixtures/workdir',
      watchDir: 'D:/fixtures/workdir',
    };
  }, samplePromptFile);

  await page.getByTestId('pick-json-file').click();
  await page.evaluate(() => {
    window.__REBUILDCHAT_TEST_API__?.setRunConfig({
      maxRoundsInput: '3',
      stopOnNoChanges: true,
      watchDir: 'D:/fixtures/workdir',
      workDir: 'D:/fixtures/workdir',
    });
  });

  await waitForPageState(
    page,
    (state) => state.queueLength === 3 && state.workDir === 'D:/fixtures/workdir' && state.watchDir === 'D:/fixtures/workdir',
    15000,
    'seeded prompt file and directories'
  );
};

const assertText = async (locator, expected, label) => {
  const actual = await locator.innerText();
  if (actual !== expected) {
    throw new Error(`${label} mismatch. Expected: ${expected}. Actual: ${actual}`);
  }
};

const main = async () => {
  ensureCompiledAssets();

  const server = createStaticServer();
  await startServer(server);

  let app;

  try {
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry],
    });

    await wait(4000);
    const page = getMainWindow(app);
    if (!page) {
      throw new Error('Failed to find the main RebuildChat window.');
    }

    await page.goto(`http://localhost:${port}/main_window/index.html#/rebuildchat`);
    await page.waitForFunction(() => Boolean(window.__REBUILDCHAT_TEST_API__), null, { timeout: 15000 });

    await installFakeRuntime(page, 'resume-flow');
    await seedPage(page);

    await page.getByTestId('run-start').click();
    await waitForPageState(page, (state) => state.runStatus === 'running', 15000, 'running state after start');
    await page.getByTestId('run-pause').click();
    await waitForPageState(page, (state) => state.runStatus === 'paused', 10000, 'paused state after pause');

    await assertText(page.getByTestId('run-status-value'), 'paused', 'pause status');

    const conversationText = await page.getByTestId('conversation-id-box').innerText();
    if (!conversationText.includes('conv-test-1234')) {
      throw new Error(`conversationId box mismatch: ${conversationText}`);
    }

    const pausedTurnCount = await page.getByTestId('turn-record-card').count();
    if (pausedTurnCount !== 1) {
      throw new Error(`Expected 1 turn record after pause, got ${pausedTurnCount}`);
    }

    await page.getByTestId('run-resume').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'completed' && state.runEndReason === 'no_output',
      15000,
      'completed no_output state after resume'
    );

    await assertText(page.getByTestId('run-end-reason-value'), '本轮无文件产出', 'resume end reason');

    const completedTurnCount = await page.getByTestId('turn-record-card').count();
    if (completedTurnCount !== 3) {
      throw new Error(`Expected 3 turn records after resume flow, got ${completedTurnCount}`);
    }

    const logCount = await page.getByTestId('run-log-row').count();
    if (logCount <= 0) {
      throw new Error('Expected run logs to be visible after resume flow.');
    }

    await installFakeRuntime(page, 'abort-flow');
    await page.getByTestId('run-start').click();
    await waitForPageState(page, (state) => state.runStatus === 'running', 15000, 'running state before abort');
    await page.getByTestId('run-abort').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'completed' && state.runEndReason === 'aborted',
      15000,
      'completed aborted state after abort'
    );

    await assertText(page.getByTestId('run-end-reason-value'), '人工中止', 'abort end reason');

    const firstTurnText = await page.getByTestId('turn-record-card').first().innerText();
    if (!firstTurnText.includes('aborted')) {
      throw new Error(`Expected aborted turn record after abort flow, got: ${firstTurnText}`);
    }

    console.log('RebuildChat page smoke passed.');
  } finally {
    if (app) {
      await app.close().catch(() => {});
    }
    await stopServer(server);
  }
};

await main();
