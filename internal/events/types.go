package events

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Severity string

const (
	SeverityInfo  Severity = "info"
	SeverityWarn  Severity = "warn"
	SeverityError Severity = "error"
	SeverityFatal Severity = "fatal"
)

type TraceContext struct {
	TraceID string `json:"trace_id,omitempty"`
	SpanID  string `json:"span_id,omitempty"`
}

// DomainEvent is the canonical payload we put inside EventBridge "detail".
type DomainEvent struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"` // e.g. "JobFailed", "ServiceError"
	Severity  Severity     `json:"severity"`
	Message   string       `json:"message"`
	At        time.Time    `json:"at"`
	Trace     TraceContext `json:"trace,omitempty"`
	Props     any          `json:"props,omitempty"`
	Error     *ErrorInfo   `json:"error,omitempty"`
	Actor     *ActorInfo   `json:"actor,omitempty"`
	Request   *RequestInfo `json:"request,omitempty"`
	Component string       `json:"component,omitempty"`
}

type ErrorInfo struct {
	Type    string `json:"type,omitempty"`
	Message string `json:"message,omitempty"`
	Stack   string `json:"stack,omitempty"`
}

type ActorInfo struct {
	UserID string `json:"user_id,omitempty"`
	Email  string `json:"email,omitempty"`
}

type RequestInfo struct {
	Method string `json:"method,omitempty"`
	Path   string `json:"path,omitempty"`
}

func (e DomainEvent) Validate() error {
	if strings.TrimSpace(e.ID) == "" {
		return errors.New("missing id")
	}
	if strings.TrimSpace(e.Name) == "" {
		return errors.New("missing name")
	}
	switch e.Severity {
	case SeverityInfo, SeverityWarn, SeverityError, SeverityFatal:
	default:
		return errors.New("invalid severity")
	}
	if strings.TrimSpace(e.Message) == "" {
		return errors.New("missing message")
	}
	if e.At.IsZero() {
		return errors.New("missing at")
	}
	return nil
}

func ParseDomainEvent(detail json.RawMessage) (DomainEvent, error) {
	var e DomainEvent
	if err := json.Unmarshal(detail, &e); err != nil {
		return DomainEvent{}, err
	}
	if err := e.Validate(); err != nil {
		return DomainEvent{}, err
	}
	return e, nil
}

