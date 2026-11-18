import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL only cleans up on its own when Vitest globals are on; they aren't here.
afterEach(() => cleanup());
