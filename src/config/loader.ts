import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { ConfigSchema, type WqbConfig, type Backlog, BacklogSchema, type QualityGateCommand } from "./schema.js";

export function loadConfig(configPath = "wqb.config.yaml"): WqbConfig {
  if (!fs.existsSync(configPath)) {
    return ConfigSchema.parse({});
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = yaml.parse(raw);
  return ConfigSchema.parse(parsed ?? {});
}

export function autoDetectQualityGates(projectRoot: string): QualityGateCommand[] {
  const gates: QualityGateCommand[] = [];

  // 1. Node / TypeScript (package.json)
  const pkgPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts || {};
      const pm = fs.existsSync(path.join(projectRoot, "pnpm-lock.yaml"))
        ? "pnpm"
        : fs.existsSync(path.join(projectRoot, "yarn.lock"))
          ? "yarn"
          : "npm";

      if (scripts.typecheck) {
        gates.push({ name: "typecheck", cmd: `${pm} run typecheck` });
      }
      if (scripts.lint) {
        gates.push({ name: "lint", cmd: `${pm} run lint` });
      }
      if (scripts.test) {
        gates.push({ name: "test", cmd: `${pm} test` });
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  // 2. Python (pyproject.toml)
  const pyprojectPath = path.join(projectRoot, "pyproject.toml");
  if (gates.length === 0 && fs.existsSync(pyprojectPath)) {
    gates.push({ name: "lint", cmd: "ruff check ." });
    gates.push({ name: "typecheck", cmd: "mypy ." });
    gates.push({ name: "test", cmd: "pytest" });
  }

  // 3. Go (go.mod)
  const goModPath = path.join(projectRoot, "go.mod");
  if (gates.length === 0 && fs.existsSync(goModPath)) {
    gates.push({ name: "vet", cmd: "go vet ./..." });
    gates.push({ name: "test", cmd: "go test ./..." });
  }

  if (gates.length === 0) {
    gates.push(
      { name: "typecheck", cmd: "npm run typecheck" },
      { name: "lint", cmd: "npm run lint" },
      { name: "test", cmd: "npm test" }
    );
  }

  return gates;
}

export function resolvePromptPath(templatePath: string): string {
  if (fs.existsSync(templatePath)) {
    return templatePath;
  }
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  const pkgPromptPath = path.resolve(currentDir, "../../", templatePath);
  if (fs.existsSync(pkgPromptPath)) {
    return pkgPromptPath;
  }
  return templatePath;
}

export function compilePrompt(templatePath: string, variables: Record<string, string>): string {
  const resolvedPath = resolvePromptPath(templatePath);
  let content = fs.readFileSync(resolvedPath, "utf-8");
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    content = content.replace(regex, value);
  }
  return content;
}

export function saveBacklog(backlogPath: string, backlog: Backlog): void {
  const dir = path.dirname(backlogPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(backlogPath, JSON.stringify(backlog, null, 2), "utf-8");
}

export function loadBacklog(backlogPath: string): Backlog | null {
  if (!fs.existsSync(backlogPath)) {
    return null;
  }
  const raw = fs.readFileSync(backlogPath, "utf-8");
  const parsed = JSON.parse(raw);
  return BacklogSchema.parse(parsed);
}
