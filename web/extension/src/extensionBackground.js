import { reclaimExtensionSDK } from "@umia/zktls-extension-sdk";
import { installProviderPermissionGate } from "./providerPermissionGate";

installProviderPermissionGate(
  reclaimExtensionSDK.initializeBackground({
    profiles: __UMIA_EXTENSION_ENDPOINT_PROFILES__.map((entry) => entry.profile),
  }),
);
