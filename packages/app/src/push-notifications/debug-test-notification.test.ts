import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const expoMocks = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
  setNotificationHandler: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  addNotificationReceivedListener: vi.fn(),
  sendOsNotification: vi.fn(),
  handlers: [] as Array<(event: { request: { identifier: string } }) => void>,
}));

vi.mock("expo-notifications", () => ({
  PermissionStatus: { GRANTED: "granted", DENIED: "denied" },
  AndroidImportance: { MAX: 4 },
  getPermissionsAsync: expoMocks.getPermissionsAsync,
  requestPermissionsAsync: expoMocks.requestPermissionsAsync,
  setNotificationChannelAsync: expoMocks.setNotificationChannelAsync,
  setNotificationHandler: expoMocks.setNotificationHandler,
  scheduleNotificationAsync: expoMocks.scheduleNotificationAsync,
  addNotificationReceivedListener: expoMocks.addNotificationReceivedListener,
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: {} },
}));

vi.mock("@/utils/os-notifications", () => ({
  sendOsNotification: expoMocks.sendOsNotification,
}));

async function loadForPlatform(platform: "web" | "android") {
  vi.resetModules();
  vi.doMock("@/constants/platform", () => ({
    isWeb: platform === "web",
    isNative: platform !== "web",
    isAndroid: platform === "android",
  }));
  return import("./debug-test-notification");
}

afterEach(() => {
  vi.doUnmock("@/constants/platform");
  vi.resetModules();
});

beforeEach(() => {
  vi.unstubAllGlobals();
  expoMocks.handlers.length = 0;
  for (const mock of [
    expoMocks.getPermissionsAsync,
    expoMocks.requestPermissionsAsync,
    expoMocks.setNotificationChannelAsync,
    expoMocks.setNotificationHandler,
    expoMocks.scheduleNotificationAsync,
    expoMocks.addNotificationReceivedListener,
    expoMocks.sendOsNotification,
  ]) {
    mock.mockReset();
  }
  expoMocks.addNotificationReceivedListener.mockImplementation((listener) => {
    expoMocks.handlers.push(listener);
    return { remove: vi.fn() };
  });
});

describe("sendDebugTestNotification", () => {
  it("uses the Web Notification API on web instead of expo scheduling", async () => {
    // Real expo-notifications has no web scheduler: getPermissionsAsync throws.
    expoMocks.getPermissionsAsync.mockRejectedValue(new Error("expo-notifications unavailable"));
    expoMocks.sendOsNotification.mockResolvedValue(true);
    const { sendDebugTestNotification } = await loadForPlatform("web");

    const result = await sendDebugTestNotification();

    expect(result).toEqual({ ok: true });
    expect(expoMocks.sendOsNotification).toHaveBeenCalledOnce();
    expect(expoMocks.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it("keeps the foreground banner handler until the notification presents on Android", async () => {
    expoMocks.getPermissionsAsync.mockResolvedValue({ status: "granted", canAskAgain: true });
    expoMocks.scheduleNotificationAsync.mockResolvedValue("test-id");
    const { sendDebugTestNotification } = await loadForPlatform("android");

    const pending = sendDebugTestNotification();
    await vi.waitFor(() => expect(expoMocks.scheduleNotificationAsync).toHaveBeenCalledOnce());
    // Presentation hasn't happened yet: the suppressive restore must not have run.
    const restoreCalls = expoMocks.setNotificationHandler.mock.calls.filter(
      ([handler]) => handler !== undefined,
    );
    expect(restoreCalls).toHaveLength(1);

    expoMocks.handlers.forEach((listener) => listener({ request: { identifier: "test-id" } }));
    const result = await pending;

    expect(result).toEqual({ ok: true });
    expect(expoMocks.setNotificationHandler.mock.calls.length).toBeGreaterThan(1);
  });

  it("restores the default handler even if presentation is never observed", async () => {
    vi.useFakeTimers();
    try {
      expoMocks.getPermissionsAsync.mockResolvedValue({ status: "granted", canAskAgain: true });
      expoMocks.scheduleNotificationAsync.mockResolvedValue("test-id");
      const { sendDebugTestNotification } = await loadForPlatform("android");

      const pending = sendDebugTestNotification();
      await vi.advanceTimersByTimeAsync(9000);
      const result = await pending;

      expect(result).toEqual({ ok: true });
      expect(expoMocks.setNotificationHandler.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
