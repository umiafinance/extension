import { isZktlsPathSegment } from "@umia/zktls-config/login-url";

function safePathSegment(value) {
  if (!isZktlsPathSegment(value)) throw new Error("Invalid backend path segment");
  return value;
}

export const API_ENDPOINTS = {
  PROVIDER_URL: (providerId, backendUrl) =>
    `${backendUrl}/api/providers/${safePathSegment(providerId)}`,
  UPDATE_SESSION_STATUS: (backendUrl) => `${backendUrl}/api/sdk/update/session/`,
  TELEMETRY: (backendUrl) => `${backendUrl}/api/sdk/telemetry`,
  STATUS_URL: (sessionId, backendUrl) =>
    `${backendUrl}/api/sdk/session/${safePathSegment(sessionId)}`,
  PROOF_INTAKE_URL: (sessionId, backendUrl) =>
    `${backendUrl}/session/${safePathSegment(sessionId)}/proof`,
};
