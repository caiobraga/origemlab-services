import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { randomUUID } from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

export async function publishDomainEvent(detail) {
  const disabled = String(process.env.DISABLE_EVENTBRIDGE || "").trim();
  if (disabled && disabled !== "0" && disabled.toLowerCase() !== "false") return;
  const busName = (process.env.EVENT_BUS_NAME || "default").trim() || "default";
  const eb = new EventBridgeClient({});
  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: busName,
          Source: "origemlab",
          DetailType: "DomainEvent",
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );
}

export function makeEventBase({ name, severity, message, component, props, error }) {
  return {
    id: randomUUID(),
    name,
    severity,
    message,
    at: nowIso(),
    component,
    props,
    error,
  };
}

