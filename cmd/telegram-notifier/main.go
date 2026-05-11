package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"

	olEvents "origemlab/services/internal/events"
	"origemlab/services/internal/telegram"
)

func formatMsg(eb events.EventBridgeEvent, de olEvents.DomainEvent) string {
	sev := strings.ToUpper(string(de.Severity))
	when := de.At.In(time.FixedZone("BRT", -3*60*60)).Format("02/01 15:04:05")

	lines := []string{
		fmt.Sprintf("[%s] %s", sev, de.Name),
		de.Message,
		fmt.Sprintf("at: %s", when),
	}

	if eb.Source != "" {
		lines = append(lines, fmt.Sprintf("source: %s", eb.Source))
	}
	if eb.DetailType != "" {
		lines = append(lines, fmt.Sprintf("detail-type: %s", eb.DetailType))
	}
	if de.Component != "" {
		lines = append(lines, fmt.Sprintf("component: %s", de.Component))
	}
	if de.Trace.TraceID != "" {
		lines = append(lines, fmt.Sprintf("trace: %s", de.Trace.TraceID))
	}
	if de.Actor != nil && (de.Actor.UserID != "" || de.Actor.Email != "") {
		lines = append(lines, fmt.Sprintf("actor: %s %s", de.Actor.UserID, de.Actor.Email))
	}
	if de.Request != nil && (de.Request.Method != "" || de.Request.Path != "") {
		lines = append(lines, fmt.Sprintf("req: %s %s", de.Request.Method, de.Request.Path))
	}
	if de.Error != nil && (de.Error.Type != "" || de.Error.Message != "") {
		lines = append(lines, fmt.Sprintf("error: %s %s", de.Error.Type, de.Error.Message))
	}

	return strings.Join(lines, "\n")
}

func handler(ctx context.Context, eb events.EventBridgeEvent) error {
	c, err := telegram.NewClient(os.Getenv("TELEGRAM_BOT_TOKEN"), os.Getenv("TELEGRAM_CHAT_ID"))
	if err != nil {
		return err
	}

	// EventBridgeEvent.Detail is `json.RawMessage` under the hood.
	raw, err := json.Marshal(eb.Detail)
	if err != nil {
		return err
	}

	de, err := olEvents.ParseDomainEvent(raw)
	if err != nil {
		// best-effort: still send something helpful
		msg := fmt.Sprintf("[WARN] Unparseable event detail\nsource: %s\ndetail-type: %s\nraw: %s",
			eb.Source,
			eb.DetailType,
			string(raw),
		)
		return c.SendMessage(ctx, msg)
	}

	return c.SendMessage(ctx, formatMsg(eb, de))
}

func main() {
	lambda.Start(handler)
}

