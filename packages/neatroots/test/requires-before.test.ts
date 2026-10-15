import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store/db.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import type { RuleCheck } from "../src/checks/types.js";
import { batch, hex, tmpHome, toolSpan } from "./helpers.js";

const homes: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const yaml = `
- id: lookup-before-refund
  kind: rule
  title: Refund without looking up the order
  rule:
    type: requires_before
    span: { tool: issue_refund }
    requires: { tool: lookup_order }
  guidance: "{tool} was called with no earlier successful {requires} call."
`;
const parsed = parseChecks(yaml);
const check = parsed.checks[0] as RuleCheck;

interface Call {
  tool: string;
  fail?: boolean;
  /** Start together with the previous call instead of after it. */
  parallel?: boolean;
}

function run(calls: Call[]) {
  const h = tmpHome();
  homes.push(h);
  const st = new Store(path.join(h, "data"));
  const t = hex(16);
  const root = hex(8);
  const spans = calls.map((c) => (c.fail ? toolSpan(t, root, c.tool, "{}", undefined, "HTTP 500") : toolSpan(t, root, c.tool, "{}", '{"ok":true}')));
  calls.forEach((c, i) => {
    if (c.parallel && i > 0) spans[i].startTimeUnixNano = spans[i - 1].startTimeUnixNano;
  });
  st.ingest([batch(spans)]);
  return evaluateRule(check, loadTrace(st, t), true);
}

describe("requires_before", () => {
  it("parses the rule", () => {
    expect(parsed.errors).toEqual([]);
    expect(check.rule.type).toBe("requires_before");
  });

  it("stays quiet when the lookup came first", () => {
    expect(run([{ tool: "lookup_order" }, { tool: "issue_refund" }])).toBeNull();
  });

  it("fires when the refund has no lookup at all", () => {
    const hit = run([{ tool: "issue_refund" }])!;
    expect(hit.firing).toBe(true);
    expect(hit.params).toMatchObject({ tool: "issue_refund", requires: "lookup_order", count: "1" });
  });

  it("counts a lookup whose status is unset", () => {
    const h = tmpHome();
    homes.push(h);
    const st = new Store(path.join(h, "data"));
    const t = hex(16);
    const root = hex(8);
    const lookup = toolSpan(t, root, "lookup_order", "{}", '{"ok":true}');
    lookup.status = { code: 0 };
    st.ingest([batch([lookup, toolSpan(t, root, "issue_refund", "{}", '{"ok":true}')])]);
    expect(evaluateRule(check, loadTrace(st, t), true)).toBeNull();
  });

  it("fires when the lookup failed", () => {
    expect(run([{ tool: "lookup_order", fail: true }, { tool: "issue_refund" }])?.firing).toBe(true);
  });

  it("fires when the lookup came after the refund", () => {
    expect(run([{ tool: "issue_refund" }, { tool: "lookup_order" }])?.firing).toBe(true);
  });

  it("does not fire when the guarded tool is never called", () => {
    expect(run([{ tool: "lookup_order" }, { tool: "send_email" }])).toBeNull();
  });

  it("counts every unguarded call", () => {
    expect(run([{ tool: "issue_refund" }, { tool: "issue_refund" }])?.params.count).toBe("2");
  });

  it("does not guess when the two calls started together", () => {
    expect(run([{ tool: "lookup_order" }, { tool: "issue_refund", parallel: true }])).toBeNull();
  });

  it("waits for a lookup that arrives a little after the refund in a live run", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = tmpHome();
    homes.push(h);
    const st = new Store(path.join(h, "data"));
    const t = hex(16);
    const root = hex(8);
    const lookup = toolSpan(t, root, "lookup_order", "{}", '{"ok":true}');
    st.ingest([batch([toolSpan(t, root, "issue_refund", "{}", '{"ok":true}')])]);
    expect(evaluateRule(check, loadTrace(st, t), false)).toBeNull();
    vi.setSystemTime(Date.now() + 2000);
    st.ingest([batch([lookup])]);
    vi.setSystemTime(Date.now() + 5000);
    expect(evaluateRule(check, loadTrace(st, t), false)).toBeNull();
  });

  it("fires once the wait is over and clears when the lookup turns up later", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = tmpHome();
    homes.push(h);
    const st = new Store(path.join(h, "data"));
    const t = hex(16);
    const root = hex(8);
    const lookup = toolSpan(t, root, "lookup_order", "{}", '{"ok":true}');
    const refund = toolSpan(t, root, "issue_refund", "{}", '{"ok":true}');
    st.ingest([batch([refund])]);
    vi.setSystemTime(Date.now() + 5000);
    expect(evaluateRule(check, loadTrace(st, t), false)?.firing).toBe(true);
    vi.setSystemTime(Date.now() + 1000);
    st.ingest([batch([lookup])]);
    expect(evaluateRule(check, loadTrace(st, t), false)).toMatchObject({ firing: false, evidenceSpanIds: [refund.spanId] });
  });

  it("judges a live call straight away when wait_ms is 0", () => {
    const eager = parseChecks(yaml.replace("lookup_order }", "lookup_order }\n    wait_ms: 0")).checks[0] as RuleCheck;
    const h = tmpHome();
    homes.push(h);
    const st = new Store(path.join(h, "data"));
    const t = hex(16);
    st.ingest([batch([toolSpan(t, hex(8), "issue_refund", "{}", '{"ok":true}')])]);
    expect(evaluateRule(eager, loadTrace(st, t), false)?.firing).toBe(true);
  });

  it("labeled smoke: 120 generated runs, every verdict matches the label", () => {
    let tp = 0, fn = 0, fp = 0, tn = 0;
    for (let i = 0; i < 120; i++) {
      const kind = i % 8;
      let calls: Call[], expectFire: boolean;
      if (kind === 0) { calls = [{ tool: "lookup_order" }, { tool: "issue_refund" }]; expectFire = false; }
      else if (kind === 1) { calls = [{ tool: "issue_refund" }]; expectFire = true; }
      else if (kind === 2) { calls = [{ tool: "lookup_order", fail: true }, { tool: "issue_refund" }]; expectFire = true; }
      else if (kind === 3) { calls = [{ tool: "issue_refund" }, { tool: "lookup_order" }]; expectFire = true; }
      else if (kind === 4) { calls = [{ tool: "search" }, { tool: "send_email" }]; expectFire = false; }
      else if (kind === 5) { calls = [{ tool: "lookup_order", fail: true }, { tool: "lookup_order" }, { tool: "issue_refund" }]; expectFire = false; }
      else if (kind === 6) { calls = [{ tool: "lookup_order" }, { tool: "issue_refund", parallel: true }]; expectFire = false; }
      else { calls = [{ tool: "search" }, { tool: "issue_refund" }, { tool: "lookup_order" }]; expectFire = true; }
      const fired = run(calls)?.firing === true;
      if (expectFire && fired) tp++; else if (expectFire) fn++; else if (fired) fp++; else tn++;
    }
    expect({ tp, fn, fp, tn }).toEqual({ tp: 60, fn: 0, fp: 0, tn: 60 });
  });
});
