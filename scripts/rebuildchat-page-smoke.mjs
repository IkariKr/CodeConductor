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
const port = Number(process.env.REBUILDCHAT_SMOKE_PORT || '3100');

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

const largeSamplePromptFile = JSON.stringify({
  chunkedPrompt: {
    chunks: Array.from({ length: 50 }, (_, index) => ({
      text: `task ${index + 1}`,
      role: 'user',
      tokenCount: 10,
    })),
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

  console.error(`[smoke] wait timeout for ${label}: ${JSON.stringify(lastState)}`);
  try {
    const runLogText = await page.getByTestId('run-log-panel').innerText();
    console.error(`[smoke] run log panel for ${label}:\n${runLogText}`);
  } catch {}
  throw new Error(`Timed out waiting for ${label}. Last state: ${JSON.stringify(lastState)}`);
};

const installFakeRuntime = async (page, mode) => {
  await page.evaluate((currentMode) => {
      if (currentMode === 'quota-wait-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: (() => {
          let compareIndex = 0;
          const changes = [
            { created: [], updated: [], deleted: [] },
            { created: ['summary.md'], updated: [], deleted: [] },
            { created: ['summary.md'], updated: [], deleted: [] },
          ];

          return () => {
            const next = changes[Math.min(compareIndex, changes.length - 1)];
            compareIndex += 1;
            return next;
          };
        })(),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async () => {
            const current = callIndex++;
            return {
              id: `quota-${current + 1}`,
              promise: new Promise((resolve) => {
                setTimeout(() => {
                  if (current === 0) {
                    resolve({
                      output: 'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 0s.',
                      conversationId: 'conv-quota-1',
                      exitCode: 1,
                      logFilePath: 'stub.log',
                      rawLog: 'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 0s.',
                    });
                    return;
                  }

                  resolve({
                    output: `TURN_OK_${current + 1}`,
                    conversationId: 'conv-quota-1',
                    exitCode: 0,
                    logFilePath: 'stub.log',
                    rawLog: 'stub',
                  });
                }, 300);
              }),
              abort: async () => {},
            };
          };
        })(),
      };
      return;
    }

    if (currentMode === 'timeout-turn-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: () => ({ created: ['summary.md'], updated: [], deleted: [] }),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async () => {
            const current = callIndex++;
            let resolvePromise;
            const promise = new Promise((resolve) => {
              resolvePromise = resolve;
            });

            return {
              id: `timeout-turn-${current + 1}`,
              promise,
              abort: async () => {
                resolvePromise({
                  output: '',
                  conversationId: 'conv-timeout-turn',
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

    if (currentMode === 'timeout-start-prompt-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: () => ({ created: ['summary.md'], updated: [], deleted: [] }),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async () => {
            const current = callIndex++;
            let resolvePromise;
            const promise = new Promise((resolve) => {
              resolvePromise = resolve;
            });

            return {
              id: `timeout-start-prompt-${current + 1}`,
              promise,
              abort: async () => {
                resolvePromise({
                  output: '',
                  conversationId: current === 0 ? null : 'conv-timeout-start',
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

    if (currentMode === 'error-turn-retry-success-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: () => ({ created: ['summary.md'], updated: [], deleted: [] }),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async (options) => {
            const current = callIndex++;
            const firstPromptLine = (options.prompt || '').split('\n')[0] || 'EMPTY';
            const receivedConversationId = options.conversationId ?? null;

            return {
              id: `error-turn-success-${current + 1}`,
              promise: new Promise((resolve) => {
                setTimeout(() => {
                  if (current === 0) {
                    resolve({
                      output: 'Error: Agent execution terminated due to error.',
                      conversationId: receivedConversationId || 'conv-error-turn',
                      exitCode: 1,
                      logFilePath: 'stub.log',
                      rawLog: 'Error: Agent execution terminated due to error.',
                    });
                    return;
                  }

                  resolve({
                    output: `${receivedConversationId ? 'WITH_CONV' : 'NO_CONV'}|${firstPromptLine}`,
                    conversationId: receivedConversationId || 'conv-error-turn',
                    exitCode: 0,
                    logFilePath: 'stub.log',
                    rawLog: 'stub',
                  });
                }, 250);
              }),
              abort: async () => {},
            };
          };
        })(),
      };
      return;
    }

    if (currentMode === 'error-turn-retry-paused-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: () => ({ created: ['summary.md'], updated: [], deleted: [] }),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async (options) => {
            const current = callIndex++;
            const receivedConversationId = options.conversationId ?? null;

            return {
              id: `error-turn-paused-${current + 1}`,
              promise: new Promise((resolve) => {
                setTimeout(() => {
                  resolve({
                    output: 'Error: Agent execution terminated due to error.',
                    conversationId: receivedConversationId || 'conv-error-turn-paused',
                    exitCode: 1,
                    logFilePath: 'stub.log',
                    rawLog: 'Error: Agent execution terminated due to error.',
                  });
                }, 250);
              }),
              abort: async () => {},
            };
          };
        })(),
      };
      return;
    }

    if (currentMode === 'error-start-prompt-retry-success-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: () => ({ created: ['summary.md'], updated: [], deleted: [] }),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async (options) => {
            const current = callIndex++;
            const firstPromptLine = (options.prompt || '').split('\n')[0] || 'EMPTY';
            const receivedConversationId = options.conversationId ?? null;

            return {
              id: `error-start-success-${current + 1}`,
              promise: new Promise((resolve) => {
                setTimeout(() => {
                  if (current === 0) {
                    resolve({
                      output: 'Error: Agent execution terminated due to error.',
                      conversationId: 'conv-error-start-success',
                      exitCode: 1,
                      logFilePath: 'stub.log',
                      rawLog: 'Error: Agent execution terminated due to error.',
                    });
                    return;
                  }

                  resolve({
                    output: `${receivedConversationId ? 'WITH_CONV' : 'NO_CONV'}|${firstPromptLine}`,
                    conversationId: receivedConversationId || 'conv-error-start-success',
                    exitCode: 0,
                    logFilePath: 'stub.log',
                    rawLog: 'stub',
                  });
                }, 250);
              }),
              abort: async () => {},
            };
          };
        })(),
      };
      return;
    }

    if (currentMode === 'error-start-prompt-retry-paused-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: () => ({ created: ['summary.md'], updated: [], deleted: [] }),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async () => {
            const current = callIndex++;

            return {
              id: `error-start-paused-${current + 1}`,
              promise: new Promise((resolve) => {
                setTimeout(() => {
                  resolve({
                    output: 'Error: Agent execution terminated due to error.',
                    conversationId: 'conv-error-start-paused',
                    exitCode: 1,
                    logFilePath: 'stub.log',
                    rawLog: 'Error: Agent execution terminated due to error.',
                  });
                }, 250);
              }),
              abort: async () => {},
            };
          };
        })(),
      };
      return;
    }

    if (currentMode === 'no-output-retry-success-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: (() => {
          let compareIndex = 0;
          const changes = [
            { created: [], updated: [], deleted: [] },
            { created: ['summary.md'], updated: [], deleted: [] },
          ];

          return () => {
            const next = changes[Math.min(compareIndex, changes.length - 1)];
            compareIndex += 1;
            return next;
          };
        })(),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async (options) => {
            const current = callIndex++;
            const firstPromptLine = (options.prompt || '').split('\n')[0] || 'EMPTY';
            const receivedConversationId = options.conversationId ?? null;

            return {
              id: `no-output-success-${current + 1}`,
              promise: new Promise((resolve) => {
                setTimeout(() => {
                  resolve({
                    output: `${receivedConversationId ? 'WITH_CONV' : 'NO_CONV'}|${firstPromptLine}`,
                    conversationId: receivedConversationId || 'conv-no-output-success',
                    exitCode: 0,
                    logFilePath: 'stub.log',
                    rawLog: 'stub',
                  });
                }, 250);
              }),
              abort: async () => {},
            };
          };
        })(),
      };
      return;
    }

    if (currentMode === 'no-output-retry-skip-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: (() => {
          let compareIndex = 0;
          const changes = [
            { created: [], updated: [], deleted: [] },
            { created: [], updated: [], deleted: [] },
            { created: ['summary.md'], updated: [], deleted: [] },
          ];

          return () => {
            const next = changes[Math.min(compareIndex, changes.length - 1)];
            compareIndex += 1;
            return next;
          };
        })(),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async (options) => {
            const current = callIndex++;
            const firstPromptLine = (options.prompt || '').split('\n')[0] || 'EMPTY';
            const receivedConversationId = options.conversationId ?? null;

            return {
              id: `no-output-skip-${current + 1}`,
              promise: new Promise((resolve) => {
                setTimeout(() => {
                  resolve({
                    output: `${receivedConversationId ? 'WITH_CONV' : 'NO_CONV'}|${firstPromptLine}`,
                    conversationId: receivedConversationId || 'conv-no-output-skip',
                    exitCode: 0,
                    logFilePath: 'stub.log',
                    rawLog: 'stub',
                  });
                }, 250);
              }),
              abort: async () => {},
            };
          };
        })(),
      };
      return;
    }

    if (currentMode === 'no-output-retry-pause-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: () => ({ created: [], updated: [], deleted: [] }),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async (options) => {
            const current = callIndex++;
            const firstPromptLine = (options.prompt || '').split('\n')[0] || 'EMPTY';
            const receivedConversationId = options.conversationId ?? null;

            return {
              id: `no-output-pause-${current + 1}`,
              promise: new Promise((resolve) => {
                setTimeout(() => {
                  resolve({
                    output: `${receivedConversationId ? 'WITH_CONV' : 'NO_CONV'}|${firstPromptLine}`,
                    conversationId: receivedConversationId || 'conv-no-output-pause',
                    exitCode: 0,
                    logFilePath: 'stub.log',
                    rawLog: 'stub',
                  });
                }, 250);
              }),
              abort: async () => {},
            };
          };
        })(),
      };
      return;
    }

    if (currentMode === 'no-output-retry-with-start-prompt-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: () => ({ created: [], updated: [], deleted: [] }),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async (options) => {
            const current = callIndex++;
            const firstPromptLine = (options.prompt || '').split('\n')[0] || 'EMPTY';
            const receivedConversationId = options.conversationId ?? null;

            return {
              id: `no-output-start-prompt-${current + 1}`,
              promise: new Promise((resolve) => {
                setTimeout(() => {
                  resolve({
                    output: `${receivedConversationId ? 'WITH_CONV' : 'NO_CONV'}|${firstPromptLine}`,
                    conversationId: receivedConversationId || `conv-no-output-start-${current + 1}`,
                    exitCode: 0,
                    logFilePath: 'stub.log',
                    rawLog: 'stub',
                  });
                }, 250);
              }),
              abort: async () => {},
            };
          };
        })(),
      };
      return;
    }

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

    if (currentMode === 'manual-start-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: () => ({ created: ['summary.md'], updated: [], deleted: [] }),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async (options) => {
            const current = callIndex++;
            const firstPromptLine = (options.prompt || '').split('\n')[0] || 'EMPTY';
            const receivedConversationId = options.conversationId ?? null;

            return {
              id: `manual-${current + 1}`,
              promise: new Promise((resolve) => {
                setTimeout(() => {
                  resolve({
                    output: `${receivedConversationId ? 'WITH_CONV' : 'NO_CONV'}|${firstPromptLine}`,
                    conversationId: receivedConversationId || 'conv-manual-1',
                    exitCode: 0,
                    logFilePath: 'stub.log',
                    rawLog: 'stub',
                  });
                }, 500);
              }),
              abort: async () => {},
            };
          };
        })(),
      };
      return;
    }

    if (currentMode === 'start-prompt-quota-flow') {
      window.__REBUILDCHAT_RUNTIME_OVERRIDE__ = {
        snapshotDirectory: async () => ({
          stub: { path: 'stub', size: 1, lastModified: Date.now() },
        }),
        compareDirectorySnapshots: () => ({ created: ['summary.md'], updated: [], deleted: [] }),
        startAgyPrintTurn: (() => {
          let callIndex = 0;

          return async (options) => {
            const current = callIndex++;
            const firstPromptLine = (options.prompt || '').split('\n')[0] || 'EMPTY';
            const receivedConversationId = options.conversationId ?? null;

            return {
              id: `start-prompt-quota-${current + 1}`,
              promise: new Promise((resolve) => {
                setTimeout(() => {
                  if (current === 0) {
                    resolve({
                      output: 'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 0s.',
                      conversationId: 'conv-start-quota-1',
                      exitCode: 1,
                      logFilePath: 'stub.log',
                      rawLog: 'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 0s.',
                    });
                    return;
                  }

                  resolve({
                    output: `${receivedConversationId ? 'WITH_CONV' : 'NO_CONV'}|${firstPromptLine}`,
                    conversationId: receivedConversationId || `conv-start-quota-${current + 1}`,
                    exitCode: 0,
                    logFilePath: 'stub.log',
                    rawLog: 'stub',
                  });
                }, 250);
              }),
              abort: async () => {},
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

const seedPage = async (page, options = {}) => {
  const existingDir = workspaceRoot.replace(/\\/g, '/');
  const expectedQueueLength = Number(options.expectedQueueLength ?? (options.rawContent === largeSamplePromptFile ? 50 : 3));
  await page.evaluate((timeoutOverrideMs) => {
    window.__REBUILDCHAT_TIMEOUT_OVERRIDE_MS__ = typeof timeoutOverrideMs === 'number' ? timeoutOverrideMs : undefined;
  }, options.timeoutOverrideMs);
  await page.evaluate(({ rawContent, existingDir: nextDir }) => {
    window.__REBUILDCHAT_FILE_PICKER_OVERRIDE__ = {
      filePath: 'D:/fixtures/sample.json',
      rawContent,
      workDir: nextDir,
      watchDir: nextDir,
    };
  }, { rawContent: options.rawContent ?? samplePromptFile, existingDir });

  await page.getByTestId('pick-json-file').click();
  await page.evaluate(({ nextDir, runOptions }) => {
    window.__REBUILDCHAT_TEST_API__?.setRunConfig({
      conversationResetEveryNRoundsInput: runOptions.conversationResetEveryNRoundsInput ?? '',
      executionErrorRetryCountInput: runOptions.executionErrorRetryCountInput ?? '1',
      executionTimeoutMinutesInput: runOptions.executionTimeoutMinutesInput ?? '10',
      maxRoundsInput: runOptions.maxRoundsInput ?? '3',
      reuseConversationOnManualStart: runOptions.reuseConversationOnManualStart ?? false,
      skipTurnOnNoOutput: runOptions.skipTurnOnNoOutput ?? true,
      startPromptInput: runOptions.startPromptInput ?? '',
      startTurnInput: runOptions.startTurnInput ?? '1',
      watchDir: nextDir,
      workDir: nextDir,
    });
  }, { nextDir: existingDir, runOptions: options });

  await waitForPageState(
    page,
    (state) =>
      state.queueLength === expectedQueueLength &&
      state.workDir === existingDir &&
      state.watchDir === existingDir &&
      state.conversationResetEveryNRoundsInput === String(options.conversationResetEveryNRoundsInput ?? '') &&
      state.executionErrorRetryCountInput === String(options.executionErrorRetryCountInput ?? '1') &&
      state.executionTimeoutMinutesInput === String(options.executionTimeoutMinutesInput ?? '10') &&
      state.effectiveMaxRounds === Number(options.maxRoundsInput ?? '3') &&
      state.skipTurnOnNoOutput === Boolean(options.skipTurnOnNoOutput ?? true) &&
      state.startPromptInput === String(options.startPromptInput ?? '') &&
      state.startTurnInput === String(options.startTurnInput ?? '1') &&
      state.reuseConversationOnManualStart === Boolean(options.reuseConversationOnManualStart ?? false),
    15000,
    'seeded prompt file and directories'
  );
};

const launchMainWindow = async () => {
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [mainEntry],
  });

  let page = null;
  const startedAt = Date.now();
  while (!page && Date.now() - startedAt < 15000) {
    await wait(500);
    page = getMainWindow(app) ?? null;
  }

  if (!page) {
    await app.close().catch(() => {});
    throw new Error('Failed to find the main RebuildChat window.');
  }

  await page.goto(`http://localhost:${port}/main_window/index.html#/rebuildchat`);
  await page.waitForFunction(() => Boolean(window.__REBUILDCHAT_TEST_API__), null, { timeout: 15000 });
  return { app, page };
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
    ({ app } = await launchMainWindow());
    let page = getMainWindow(app);
    if (!page) {
      throw new Error('Failed to find the main RebuildChat window.');
    }

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());
    await installFakeRuntime(page, 'quota-wait-flow');
    await seedPage(page, { maxRoundsInput: '1', skipTurnOnNoOutput: false });
    console.log('[smoke] quota scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(page, (state) => state.runStatus === 'waiting_retry' && state.retryAttemptCount === 1, 15000, 'quota waiting state');
    console.log('[smoke] quota waiting reached');
    await waitForPageState(
      page,
      (state) => state.runStatus === 'completed' && state.runEndReason === 'max_rounds' && state.turnRecordCount === 1,
      25000,
      'quota auto retry completion'
    );
    console.log('[smoke] quota scenario completed');

    await assertText(page.getByTestId('run-end-reason-value'), '达到最大轮数', 'quota retry end reason');
    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'timeout-start-prompt-flow');
    await seedPage(page, {
      maxRoundsInput: '1',
      executionTimeoutMinutesInput: '1',
      startPromptInput: 'WARMUP',
      skipTurnOnNoOutput: false,
      timeoutOverrideMs: 50,
    });
    console.log('[smoke] start prompt timeout scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'paused' && state.currentTurnIndex === 0 && state.startPromptRecordCount === 0 && state.turnRecordCount === 0,
      15000,
      'start prompt timeout paused'
    );
    console.log('[smoke] start prompt timeout scenario paused');
    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'timeout-turn-flow');
    await seedPage(page, {
      maxRoundsInput: '1',
      executionTimeoutMinutesInput: '1',
      skipTurnOnNoOutput: false,
      timeoutOverrideMs: 50,
    });
    console.log('[smoke] turn timeout scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'paused' && state.currentTurnIndex === 0 && state.turnRecordCount === 0,
      15000,
      'turn timeout paused'
    );
    console.log('[smoke] turn timeout scenario paused');
    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'no-output-retry-success-flow');
    await seedPage(page, {
      maxRoundsInput: '1',
      skipTurnOnNoOutput: true,
    });
    console.log('[smoke] no output retry success scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'completed' && state.runEndReason === 'max_rounds' && state.turnRecordCount === 1,
      15000,
      'no output retry success completion'
    );

    const noOutputSuccessText = await page.getByTestId('turn-record-card').first().innerText();
    if (!noOutputSuccessText.includes('completed') || !noOutputSuccessText.includes('NO_CONV|第 1 条')) {
      throw new Error(`Expected no output retry success turn record, got: ${noOutputSuccessText}`);
    }

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'no-output-retry-skip-flow');
    await seedPage(page, {
      maxRoundsInput: '2',
      skipTurnOnNoOutput: true,
    });
    console.log('[smoke] no output retry skip scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'completed' && state.runEndReason === 'max_rounds' && state.turnRecordCount === 2 && state.currentTurnIndex === 2,
      15000,
      'no output retry skip completion'
    );

    const noOutputSkipCards = await page.getByTestId('turn-record-card').allInnerTexts();
    if (!noOutputSkipCards[0]?.includes('skipped') || !noOutputSkipCards[1]?.includes('WITH_CONV|第 2 条')) {
      throw new Error(`Expected skipped first turn and continued second turn after no output retry, got: ${JSON.stringify(noOutputSkipCards)}`);
    }

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'no-output-retry-pause-flow');
    await seedPage(page, {
      maxRoundsInput: '1',
      skipTurnOnNoOutput: false,
    });
    console.log('[smoke] no output retry pause scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'paused' && state.currentTurnIndex === 0 && state.turnRecordCount === 0,
      15000,
      'no output retry pause completion'
    );

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'no-output-retry-with-start-prompt-flow');
    await seedPage(page, {
      maxRoundsInput: '1',
      skipTurnOnNoOutput: true,
      startPromptInput: 'WARMUP',
    });
    console.log('[smoke] no output retry with start prompt scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) =>
        state.runStatus === 'completed' &&
        state.runEndReason === 'max_rounds' &&
        state.startPromptRecordCount === 2 &&
        state.turnRecordCount === 1,
      15000,
      'no output retry with start prompt completion'
    );

    const noOutputStartPromptCards = await page.getByTestId('start-prompt-record-card').allInnerTexts();
    const noOutputStartTurnText = await page.getByTestId('turn-record-card').first().innerText();
    if (!noOutputStartPromptCards[0]?.includes('WARMUP') || !noOutputStartPromptCards[1]?.includes('WARMUP') || !noOutputStartTurnText.includes('skipped')) {
      throw new Error(`Expected start prompt to replay before no output retry, got prompts=${JSON.stringify(noOutputStartPromptCards)} turn=${noOutputStartTurnText}`);
    }

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'error-turn-retry-success-flow');
    await seedPage(page, {
      maxRoundsInput: '1',
      executionErrorRetryCountInput: '1',
      skipTurnOnNoOutput: false,
    });
    console.log('[smoke] turn error retry success scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'completed' && state.runEndReason === 'max_rounds' && state.turnRecordCount === 1,
      15000,
      'turn error retry success completion'
    );

    const turnErrorSuccessText = await page.getByTestId('turn-record-card').first().innerText();
    if (!turnErrorSuccessText.includes('NO_CONV|第 1 条')) {
      throw new Error(`Expected recovered turn output after ordinary error retry, got: ${turnErrorSuccessText}`);
    }

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'error-turn-retry-paused-flow');
    await seedPage(page, {
      maxRoundsInput: '1',
      executionErrorRetryCountInput: '1',
      skipTurnOnNoOutput: false,
    });
    console.log('[smoke] turn error retry paused scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'paused' && state.currentTurnIndex === 0 && state.turnRecordCount === 0,
      15000,
      'turn error retry paused'
    );

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'error-turn-retry-paused-flow');
    await seedPage(page, {
      maxRoundsInput: '1',
      executionErrorRetryCountInput: '0',
      skipTurnOnNoOutput: false,
    });
    console.log('[smoke] turn error immediate pause scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'paused' && state.currentTurnIndex === 0 && state.turnRecordCount === 0,
      15000,
      'turn error immediate pause'
    );

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'error-start-prompt-retry-success-flow');
    await seedPage(page, {
      maxRoundsInput: '1',
      executionErrorRetryCountInput: '1',
      startPromptInput: 'WARMUP',
      skipTurnOnNoOutput: false,
    });
    console.log('[smoke] start prompt error retry success scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) =>
        state.runStatus === 'completed' &&
        state.runEndReason === 'max_rounds' &&
        state.startPromptRecordCount === 1 &&
        state.turnRecordCount === 1,
      15000,
      'start prompt error retry success completion'
    );

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'error-start-prompt-retry-paused-flow');
    await seedPage(page, {
      maxRoundsInput: '1',
      executionErrorRetryCountInput: '1',
      startPromptInput: 'WARMUP',
      skipTurnOnNoOutput: false,
    });
    console.log('[smoke] start prompt error retry paused scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'paused' && state.currentTurnIndex === 0 && state.startPromptRecordCount === 0 && state.turnRecordCount === 0,
      15000,
      'start prompt error retry paused'
    );

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'start-prompt-quota-flow');
    await seedPage(page, {
      maxRoundsInput: '1',
      startPromptInput: 'WARMUP',
      skipTurnOnNoOutput: false,
    });
    console.log('[smoke] start prompt quota scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'waiting_retry' && state.retryAttemptCount === 1 && state.startPromptRecordCount === 0 && state.turnRecordCount === 0,
      15000,
      'start prompt quota waiting state'
    );
    await waitForPageState(
      page,
      (state) =>
        state.runStatus === 'completed' &&
        state.runEndReason === 'max_rounds' &&
        state.startPromptRecordCount === 1 &&
        state.turnRecordCount === 1 &&
        state.hasSentStartPromptInCurrentConversation === true,
      25000,
      'start prompt quota auto retry completion'
    );

    const startPromptQuotaText = await page.getByTestId('start-prompt-record-card').first().innerText();
    if (!startPromptQuotaText.includes('WARMUP')) {
      throw new Error(`Expected start prompt quota record to contain WARMUP, got: ${startPromptQuotaText}`);
    }

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'manual-start-flow');
    await seedPage(page, {
      rawContent: largeSamplePromptFile,
      maxRoundsInput: '46',
      startTurnInput: '46',
      skipTurnOnNoOutput: false,
    });
    console.log('[smoke] manual start scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'completed' && state.runEndReason === 'max_rounds' && state.turnRecordCount === 1,
      15000,
      'manual start completion'
    );

    const manualStartTurnText = await page.getByTestId('turn-record-card').first().innerText();
    if (!manualStartTurnText.includes('第 46 轮') || !manualStartTurnText.includes('第 46 条') || !manualStartTurnText.includes('NO_CONV|第 46 条')) {
      throw new Error(`Expected manual start turn record to begin from 46, got: ${manualStartTurnText}`);
    }

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'manual-start-flow');
    await seedPage(page, {
      maxRoundsInput: '2',
      conversationResetEveryNRoundsInput: '1',
      startPromptInput: 'WARMUP',
      skipTurnOnNoOutput: false,
    });
    console.log('[smoke] conversation reset scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'completed' && state.runEndReason === 'max_rounds' && state.turnRecordCount === 2 && state.startPromptRecordCount === 2,
      15000,
      'conversation reset completion'
    );

    const resetTurnCards = await page.getByTestId('turn-record-card').allInnerTexts();
    if (!resetTurnCards[0]?.includes('WITH_CONV|第 1 条') || !resetTurnCards[1]?.includes('WITH_CONV|第 2 条')) {
      throw new Error(`Expected both turns to reuse the fresh conversation created by start prompt, got: ${JSON.stringify(resetTurnCards)}`);
    }

    const resetStartPromptCards = await page.getByTestId('start-prompt-record-card').allInnerTexts();
    if (!resetStartPromptCards[0]?.includes('WARMUP') || !resetStartPromptCards[1]?.includes('WARMUP')) {
      throw new Error(`Expected start prompt records before each reset turn, got: ${JSON.stringify(resetStartPromptCards)}`);
    }

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'resume-flow');
    await seedPage(page);
    console.log('[smoke] resume scenario seeded');

    await page.getByTestId('run-start').click();
    await waitForPageState(page, (state) => state.runStatus === 'running', 15000, 'running state after start');
    await page.getByTestId('run-pause').click();
    await waitForPageState(page, (state) => state.runStatus === 'paused' && state.currentTurnIndex === 1, 10000, 'paused state after pause');

    await assertText(page.getByTestId('run-status-value'), 'paused', 'pause status');

    const conversationText = await page.getByTestId('conversation-id-box').innerText();
    if (!conversationText.includes('conv-test-1234')) {
      throw new Error(`conversationId box mismatch: ${conversationText}`);
    }

    const pausedTurnCount = await page.getByTestId('turn-record-card').count();
    if (pausedTurnCount !== 1) {
      throw new Error(`Expected 1 turn record after pause, got ${pausedTurnCount}`);
    }

    const pausedTaskCount = await page.getByTestId('task-card').count();
    if (pausedTaskCount !== 1) {
      throw new Error(`Expected 1 persisted task after pause, got ${pausedTaskCount}`);
    }

    await waitForPageState(page, (state) => state.persistedCurrentTurnIndex === 1, 10000, 'persisted paused turn index');
    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.flushPersistedTasks());
    await wait(500);
    console.log('[smoke] first session persisted');

    await app.close().catch(() => {});

    ({ app, page } = await launchMainWindow());
    await installFakeRuntime(page, 'resume-flow');
    console.log('[smoke] second session launched');

    await waitForPageState(page, (state) => state.persistedTaskCount === 1 && state.persistedCurrentTurnIndex === 1, 15000, 'persisted task after relaunch');
    console.log('[smoke] relaunch task visible');
    await page.getByTestId('task-resume-button').first().click();
    console.log('[smoke] relaunch resume triggered');
    await waitForPageState(
      page,
      (state) => state.runStatus === 'completed' && state.runEndReason === 'all_sent',
      15000,
      'completed all_sent state after relaunch resume'
    );
    console.log('[smoke] relaunch resume completed');

    await assertText(page.getByTestId('run-end-reason-value'), '所有条目已发送完成', 'resume end reason');

    const completedTurnCount = await page.getByTestId('turn-record-card').count();
    if (completedTurnCount !== 3) {
      throw new Error(`Expected 3 turn records after resume flow, got ${completedTurnCount}`);
    }

    const logCount = await page.getByTestId('run-log-row').count();
    if (logCount <= 0) {
      throw new Error('Expected run logs to be visible after resume flow.');
    }

    await page.getByTestId('task-delete-button').first().click();
    await waitForPageState(page, (state) => state.persistedTaskCount === 0, 15000, 'task deletion');

    await installFakeRuntime(page, 'manual-start-flow');
    await seedPage(page, { maxRoundsInput: '3', skipTurnOnNoOutput: false });
    console.log('[smoke] manual continue scenario seeded');
    await page.getByTestId('run-start').click();
    await waitForPageState(page, (state) => state.runStatus === 'running', 15000, 'running state before manual continue pause');
    await page.getByTestId('run-pause').click();
    await waitForPageState(page, (state) => state.runStatus === 'paused' && state.currentTurnIndex === 1, 10000, 'paused state before manual continue');
    await page.evaluate(() => {
      window.__REBUILDCHAT_TEST_API__?.setRunConfig({
        startTurnInput: '3',
        reuseConversationOnManualStart: false,
      });
    });
    await waitForPageState(page, (state) => state.startTurnInput === '3' && state.reuseConversationOnManualStart === false, 10000, 'manual continue config applied');
    await page.getByTestId('run-resume').click();
    await waitForPageState(
      page,
      (state) => state.runStatus === 'completed' && state.runEndReason === 'all_sent' && state.persistedTaskCount === 2 && state.turnRecordCount === 1,
      15000,
      'manual continue fork completion'
    );

    const manualContinueText = await page.getByTestId('turn-record-card').first().innerText();
    if (!manualContinueText.includes('第 3 轮') || !manualContinueText.includes('第 3 条') || !manualContinueText.includes('NO_CONV|第 3 条')) {
      throw new Error(`Expected manual continue turn record to fork from turn 3, got: ${manualContinueText}`);
    }

    await page.evaluate(() => window.__REBUILDCHAT_TEST_API__?.clearPersistedTasks());

    await installFakeRuntime(page, 'abort-flow');
    await page.getByTestId('run-start').click();
    await waitForPageState(page, (state) => state.runStatus === 'running', 15000, 'running state before abort');
    await page.getByTestId('run-abort').click();
    console.log('[smoke] abort scenario started');
    await waitForPageState(
      page,
      (state) => state.runStatus === 'completed' && state.runEndReason === 'aborted',
      15000,
      'completed aborted state after abort'
    );
    console.log('[smoke] abort scenario completed');

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
