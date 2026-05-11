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

func prettyJSON(v any, max int) string {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return ""
	}
	s := string(b)
	if max > 0 && len(s) > max {
		return s[:max] + "\n…(truncated)"
	}
	return s
}

func formatMsg(eb events.EventBridgeEvent, de olEvents.DomainEvent) string {
	when := de.At.In(time.FixedZone("BRT", -3*60*60)).Format("02/01 15:04:05")
	head := fmt.Sprintf("[ERROR] %s", de.Name)
	lines := []string{
		head,
		de.Message,
		fmt.Sprintf("at: %s", when),
	}
	if de.Component != "" {
		lines = append(lines, fmt.Sprintf("component: %s", de.Component))
	}
	if eb.Source != "" {
		lines = append(lines, fmt.Sprintf("source: %s", eb.Source))
	}
	if eb.DetailType != "" {
		lines = append(lines, fmt.Sprintf("detail-type: %s", eb.DetailType))
	}
	if de.Trace.TraceID != "" {
		lines = append(lines, fmt.Sprintf("trace: %s", de.Trace.TraceID))
	}
	if de.Request != nil && (de.Request.Method != "" || de.Request.Path != "") {
		lines = append(lines, fmt.Sprintf("req: %s %s", de.Request.Method, de.Request.Path))
	}
	if de.Actor != nil && (de.Actor.UserID != "" || de.Actor.Email != "") {
		lines = append(lines, fmt.Sprintf("actor: %s %s", de.Actor.UserID, de.Actor.Email))
	}
	if de.Error != nil {
		if de.Error.Type != "" || de.Error.Message != "" {
			lines = append(lines, fmt.Sprintf("error: %s %s", de.Error.Type, de.Error.Message))
		}
		if st := strings.TrimSpace(de.Error.Stack); st != "" {
			if len(st) > 1500 {
				st = st[:1500] + "\n…(truncated)"
			}
			lines = append(lines, "stack:\n"+st)
		}
	}
	if de.Props != nil {
		if p := prettyJSON(de.Props, 1200); strings.TrimSpace(p) != "" {
			lines = append(lines, "props:\n"+p)
		}
	}
	return strings.Join(lines, "\n")
}

func isErrorSeverity(s olEvents.Severity) bool {
	return s == olEvents.SeverityError || s == olEvents.SeverityFatal
}

func handler(ctx context.Context, eb events.EventBridgeEvent) error {
	chatID := os.Getenv("TELEGRAM_ERROR_CHAT_ID")
	if strings.TrimSpace(chatID) == "" {
		chatID = os.Getenv("TELEGRAM_CHAT_ID")
	}
	c, err := telegram.NewClient(os.Getenv("TELEGRAM_BOT_TOKEN"), chatID)
	if err != nil {
		return err
	}

	raw, err := json.Marshal(eb.Detail)
	if err != nil {
		return err
	}
	de, err := olEvents.ParseDomainEvent(raw)
	if err != nil {
		// ignore unparseable payloads here to avoid noise
		return nil
	}
	if !isErrorSeverity(de.Severity) {
		return nil
	}
	return c.SendMessage(ctx, formatMsg(eb, de))
}

func main() {
	lambda.Start(handler)
}

