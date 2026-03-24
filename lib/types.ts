export interface VendorFingerprint {
  name: string;
  detect: string;
  open: string;
  input: string;
  messages: string;
}

export interface DetectionResult {
  found: boolean;
  method: "fingerprint" | "iframe-domain" | "ai" | "fixed-scanner" | "none";
  vendor?: string;
  confidence: "high" | "medium" | "low";
  widgetType?: string;
  launcherSelector?: string;
  iframeSelector?: string;
  notes?: string;
  screenshotBase64?: string;
}

export interface DetectionEvent {
  type: "status" | "result" | "error" | "done";
  message?: string;
  data?: DetectionResult;
}
