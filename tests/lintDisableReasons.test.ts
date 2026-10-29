import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.cwd(), "package.json"));
const tseslint = require("typescript-eslint");
interface RuleMessage {
    ruleId: string | null;
}
const { Linter } = require("eslint") as {
    Linter: new () => {
        verify(source: string, config: object[]): RuleMessage[];
        getSuppressedMessages(): RuleMessage[];
    };
};

/** Execute the real reason scanner with one in-memory TSX file, without running eslint. */
function scan(source: string): unknown[] {
    const script = fs.readFileSync(path.join(process.cwd(), "script/lint-warnings-budget.mjs"), "utf8");
    const start = script.indexOf("// ---- 第二道门禁");
    const end = script.indexOf("if (disableIssues.length > 0)", start);
    assert.ok(start >= 0 && end > start, "reason scanner section must exist");
    return vm.runInNewContext(`${script.slice(start, end).replace(/^export /gm, "")}\ndisableIssues;`, {
        ROOT: process.cwd(),
        path,
        tseslint,
        fs: {
            readdirSync: () => [{ name: "fixture.tsx", isDirectory: () => false, isFile: () => true }],
            readFileSync: () => source,
        },
    });
}

const missingReasons = [
    ["next-line", "// eslint-disable-next-line no-alert\nalert(1);"],
    ["line", "alert(1); // eslint-disable-line no-alert"],
    ["block rule", "/* eslint-disable no-alert */\nalert(1);"],
    ["quoted rule", '/* eslint-disable "no-alert" */\nalert(1);'],
    ["double hyphen in rule name", "/* eslint-disable example/no--alert */\nalert(1);"],
    ["multiple rules", "/* eslint-disable no-alert, no-debugger */\nalert(1);"],
    ["block all", "/* eslint-disable */\nalert(1);"],
    ["multiline block", "/* eslint-disable\n no-alert\n*/\nalert(1);"],
    ["next-line all", "// eslint-disable-next-line\nalert(1);"],
    ["line all", "alert(1); // eslint-disable-line"],
    ["block next-line all", "/* eslint-disable-next-line */\nalert(1);"],
    ["empty inline reason", "/* eslint-disable-next-line no-alert -- */\nalert(1);"],
    ["empty preceding comment", "//\n// eslint-disable-next-line no-alert\nalert(1);"],
];
for (const [name, source] of missingReasons) {
    test(`disable reason gate rejects ${name} without a reason`, () => {
        assert.equal(scan(source).length, 1);
    });
}

// Confirm ESLint actually suppresses these rules before testing our reason gate.
// In particular, an all-empty comma list disables every rule, rather than none.
const commaDirectives: readonly [string, string, readonly string[], readonly string[]][] = [
    ["trailing comma", "no-alert,", ["no-debugger"], ["no-alert"]],
    ["leading comma", ", no-alert", ["no-debugger"], ["no-alert"]],
    ["repeated commas", "no-alert,,no-debugger", [], ["no-alert", "no-debugger"]],
    ["only commas", ",,,", [], ["no-alert", "no-debugger"]],
];
for (const [name, rules, expectedMessages, expectedSuppressed] of commaDirectives) {
    test(`disable reason gate follows actual ESLint semantics for ${name}`, () => {
        const source = `/* eslint-disable ${rules} */\nalert(1);\ndebugger;`;
        const config = [{
            languageOptions: { ecmaVersion: 2022 },
            rules: { "no-alert": "error", "no-debugger": "error" },
        }];
        const linter = new Linter();
        assert.deepEqual(
            linter.verify("alert(1);\ndebugger;", config).map(message => message.ruleId).sort(),
            ["no-alert", "no-debugger"],
        );

        const messages = linter.verify(source, config);
        const suppressed = linter.getSuppressedMessages();

        assert.deepEqual(messages.map(message => message.ruleId).sort(), expectedMessages);
        assert.deepEqual(suppressed.map(message => message.ruleId).sort(), expectedSuppressed);
        assert.equal(scan(source).length, 1, "a real disable directive needs a reason");
        assert.equal(scan(source.replace(" */", " -- intentional test suppression */")).length, 0);
    });
}

const allowedSources = [
    ["inline reason", "// eslint-disable-next-line no-alert -- browser notification\nalert(1);"],
    ["preceding reason", "// browser notification is intentional\n// eslint-disable-next-line no-alert\nalert(1);"],
    ["block inline reason", "/* eslint-disable no-alert -- browser notification */\nalert(1);"],
    ["quoted text", 'const text = "eslint-disable-next-line no-alert";'],
    ["template text", 'const text = `// eslint-disable-next-line no-alert`;'],
    ["JSX text", "const node = <div>eslint-disable-next-line no-alert</div>;"],
    ["comment prose", "// Example: eslint-disable-next-line no-alert"],
];
for (const [name, source] of allowedSources) {
    test(`disable reason gate accepts ${name}`, () => {
        assert.equal(scan(source).length, 0);
    });
}
