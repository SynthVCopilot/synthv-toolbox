import { extname, isAbsolute, resolve } from "node:path";

export interface SvpRouteService {
  previewSvpRoute(projectPath: string): Promise<Record<string, unknown>>;
}

export function svpPathsFromArguments(argv: readonly string[], cwd?: string): string[] {
  if (argv.includes("--toolbox-autostart")) return [];
  const base = cwd && isAbsolute(cwd) ? cwd : process.cwd();
  return argv
    .filter(argument => typeof argument === "string" && extname(argument).toLowerCase() === ".svp")
    .map(argument => isAbsolute(argument) ? resolve(argument) : resolve(base, argument));
}

export async function routeSvpActivation(service: SvpRouteService, argv: readonly string[], cwd: string | undefined, emit: (event: string, payload: Record<string, unknown>) => void): Promise<boolean> {
  const paths = svpPathsFromArguments(argv, cwd);
  if (!paths.length) return false;
  for (const projectPath of paths) emit("svp-route-request", await service.previewSvpRoute(projectPath));
  return true;
}
