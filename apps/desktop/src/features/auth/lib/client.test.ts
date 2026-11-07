import { expect, it } from "vitest";
import { publicAuthConfig } from "./client";

it("accepts public project settings and refuses secret keys or unsafe API URLs", () => {
  const url = "https://project.supabase.co";
  const key = "sb_publishable_test";
  const api = "https://service.example/paperkit";
  expect(publicAuthConfig(url, key, api)?.project).toBe(url);
  expect(publicAuthConfig(url, "sb_secret_private", api)).toBeNull();
  expect(publicAuthConfig("https://user:pass@project.supabase.co", key, api)).toBeNull();
  expect(publicAuthConfig(url, key, "http://remote.example/paperkit")).toBeNull();
  expect(publicAuthConfig(url, key, "http://127.0.0.1:18080/paperkit")).not.toBeNull();
});
