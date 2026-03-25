export interface VendorFingerprint {
  name: string;
  detect: string;
  open: string;
  input: string;
  messages: string;
}

export interface DetectionResult {
  found: boolean;
  method: "fingerprint" | "iframe-domain" | "ai" | "visual" | "fixed-scanner" | "none";
  vendor?: string;
  confidence: "high" | "medium" | "low";
  widgetType?: string;
  launcherSelector?: string;
  iframeSelector?: string;
  notes?: string;
  screenshotBase64?: string;
  chatOpenScreenshotBase64?: string;
}

export interface CandidateScreenshot {
  index: number;
  label: string;
  base64: string;
  isMatch?: boolean;
}

export interface PageScreenshot {
  label: string;
  base64: string;
}

export interface DetectionEvent {
  type: "status" | "result" | "error" | "done" | "candidate" | "screenshot";
  message?: string;
  data?: DetectionResult;
  candidate?: CandidateScreenshot;
  screenshot?: PageScreenshot;
}
