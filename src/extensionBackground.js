import {
  reclaimExtensionSDK,
  ZKTLS_BOUND_SESSION_ROUTE_VERSION,
} from "@umia/reclaim-browser-extension-sdk";
import {
  loadTrustedActivationCatalogue,
  loadTrustedNetworkConfig,
  resolveActivatedSessionRoute,
} from "@umia/zktls/network-config";
import { installProviderPermissionGate } from "./providerPermissionGate";
import { initializeBoundSessionBackground } from "./sdkBoundSession";
import { createSessionRouteResolver } from "./sessionRoute";

const trustedConfigs = __UMIA_EXTENSION_NETWORK_CONFIG_RAWS__.map((raw) =>
  loadTrustedNetworkConfig(raw, new Date()),
);
const catalogue = loadTrustedActivationCatalogue(
  __UMIA_EXTENSION_ACTIVATION_RAW__,
  trustedConfigs,
  new Date(),
);
const resolveSessionRoute = createSessionRouteResolver({
  catalogue,
  resolveActivatedSessionRoute,
});
const ctx = initializeBoundSessionBackground(
  reclaimExtensionSDK,
  ZKTLS_BOUND_SESSION_ROUTE_VERSION,
  resolveSessionRoute,
);
installProviderPermissionGate(ctx);
