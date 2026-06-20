import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { requireEnv } from "../config/env";

export const convex = new ConvexHttpClient(requireEnv("convexUrl"), {
  logger: false,
});

export { api };
