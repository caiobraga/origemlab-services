import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { randomUUID } from "node:crypto";

export type DomainEventSeverity = "info" | "warn" | "error" | "fatal";

/** Payload alinhado a `internal/events/types.go` (DomainEvent). */
export type DomainEventPayload = {
  id: string;
  name: string;
  severity: DomainEventSeverity;
  message: string;
  at: string;
  component?: string;
  props?: Record<string, unknown>;
  error?: { type?: string; message?: string; stack?: string };
};

export function nowIso(): string {
  return new Date().toISOString();
}

export async function publishDomainEvent(detail: DomainEventPayload): Promise<void> {
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

export function makeEventBase(
  opts: Omit<DomainEventPayload, "id" | "at"> & { id?: string; at?: string },
): DomainEventPayload {
  return {
    id: opts.id ?? randomUUID(),
    name: opts.name,
    severity: opts.severity,
    message: opts.message,
    at: opts.at ?? nowIso(),
    component: opts.component,
    props: opts.props,
    error: opts.error,
  };
}
