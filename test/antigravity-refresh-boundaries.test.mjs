import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

function mountQuotaRing(onRefresh) {
  const filename = resolve(
    process.cwd(),
    "src/renderer/components/GeminiQuotaRing.tsx"
  );
  const source = readFileSync(filename, "utf8");

  const javascript = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;

  const state = [];
  const refs = [];
  const effects = [];
  const cleanups = [];
  const timers = new Map();

  let stateCursor = 0;
  let refCursor = 0;
  let nextTimer = 1;
  let mounted = true;

  function registerTimer(callback, kind) {
    const id = nextTimer++;
    timers.set(id, { callback, kind });
    return id;
  }

  const element = (type, props) => ({ type, props });

  const react = {
    createElement(type, props, ...children) {
      return element(type, {
        ...props,
        children: children.length === 1 ? children[0] : children
      });
    },
    useState(initial) {
      const index = stateCursor++;
      if (!(index in state)) {
        state[index] =
          typeof initial === "function" ? initial() : initial;
      }
      return [
        state[index],
        (next) => {
          if (mounted) {
            state[index] =
              typeof next === "function" ? next(state[index]) : next;
          }
        }
      ];
    },
    useRef(initial) {
      const index = refCursor++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index];
    },
    useEffect(effect) {
      effects.push(effect);
    },
    useCallback(callback) {
      return callback;
    }
  };

  const forbiddenQuotaCall = () => {
    throw new Error("Quota helpers must not run for capacity: null");
  };

  const dependencies = {
    react: { __esModule: true, default: react, ...react },
    "react/jsx-runtime": {
      jsx: element,
      jsxs: element,
      Fragment: Symbol("Fragment")
    },
    "react/jsx-dev-runtime": {
      jsxDEV: element,
      Fragment: Symbol("Fragment")
    },
    "lucide-react": new Proxy(
      {},
      { get: () => () => null }
    )
  };

  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier in dependencies) return dependencies[specifier];
      if (specifier.endsWith("/shared/contracts.js")) {
        return {
          isCapacityActive: forbiddenQuotaCall,
          calculateRemainingPercentage: forbiddenQuotaCall
        };
      }
      throw new Error(`Unexpected runtime dependency: ${specifier}`);
    },
    Date,
    console,
    setTimeout: (callback) => registerTimer(callback, "timeout"),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback) => registerTimer(callback, "interval"),
    clearInterval: (id) => timers.delete(id)
  });

  new vm.Script(javascript, { filename }).runInContext(context);

  const root = module.exports.GeminiQuotaRing({
    capacity: null,
    onRefresh
  });

  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }

  assert.equal(root.type, "button");
  assert.equal(typeof root.props.onClick, "function");

  return {
    timers,
    click() {
      return root.props.onClick({
        stopPropagation() {}
      });
    },
    unmount() {
      mounted = false;
      for (const cleanup of cleanups.reverse()) cleanup();
    }
  };
}

test("refresh rejection is contained at the React event boundary", async () => {
  const ring = mountQuotaRing(async () => {
    throw new Error("IPC channel closed");
  });

  try {
    await assert.doesNotReject(
      () => ring.click(),
      "A refresh failure must not escape the click-handler promise"
    );
  } finally {
    ring.unmount();
  }
});

test("refresh settlement after unmount creates no orphan timeout", async () => {
  let settleRefresh;
  const refreshPending = new Promise((resolvePromise) => {
    settleRefresh = resolvePromise;
  });

  const ring = mountQuotaRing(() => refreshPending);
  const clickPending = ring.click();

  ring.unmount();
  settleRefresh();
  await clickPending;

  assert.equal(
    ring.timers.size,
    0,
    "An unmounted component must not schedule a refresh-reset timer"
  );
});
