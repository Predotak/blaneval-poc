import type { VendorFingerprint } from "./types";

export const KNOWN_VENDORS: VendorFingerprint[] = [
  {
    name: "Intercom",
    detect: "#intercom-container, .intercom-launcher, iframe[name*='intercom']",
    open: ".intercom-launcher, [aria-label*='Open Intercom'], .intercom-launcher-frame",
    input: ".intercom-composer-input, [placeholder*='message' i]",
    messages: ".intercom-conversation-part-body, .intercom-block-paragraph",
  },
  {
    name: "Drift",
    detect: "#drift-widget, .drift-widget-container, iframe#drift-widget",
    open: "#drift-widget .widget-button, .drift-open-chat",
    input: "textarea.compose-box",
    messages: ".drift-message-text",
  },
  {
    name: "Zendesk",
    detect: "#launcher, iframe#launcher, [data-testid='launcher']",
    open: "#launcher, iframe#launcher",
    input: "input[placeholder*='Type a message' i], textarea[placeholder*='Type' i]",
    messages: ".message-content, [data-garden-id='chat.message']",
  },
  {
    name: "Tidio",
    detect: "#tidio-chat, #tidio-chat-iframe, .tidio-chat",
    open: "#tidio-chat-code, .tidio-1hq5mx6",
    input: "textarea[data-tidio-element='textarea']",
    messages: "[data-tidio-element='message']",
  },
  {
    name: "HubSpot",
    detect: "#hubspot-messages-iframe-container, #hs-chat-open-button",
    open: "#hubspot-messages-iframe-container .open-button, #hs-chat-open-button",
    input: "input[placeholder*='message' i], textarea[placeholder*='message' i]",
    messages: ".private-message__text, .message-bubble",
  },
  {
    name: "tawk.to",
    detect: "#tawkchat-container, iframe[title*='tawk' i]",
    open: ".tawk-button, .tawk-min-container",
    input: "textarea[placeholder*='Enter message' i]",
    messages: ".tawk-message-text",
  },
  {
    name: "Crisp",
    detect: ".crisp-client, #crisp-chatbox",
    open: ".crisp-client .cc-tlyw, [data-id='crisp']",
    input: "div[contenteditable][data-placeholder]",
    messages: ".crisp-message-text",
  },
];
