package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	Token  string
	ChatID string
	HTTP   *http.Client
}

func NewClient(token, chatID string) (*Client, error) {
	token = strings.TrimSpace(token)
	chatID = strings.TrimSpace(chatID)
	if token == "" {
		return nil, errors.New("missing TELEGRAM_BOT_TOKEN")
	}
	if chatID == "" {
		return nil, errors.New("missing TELEGRAM_CHAT_ID")
	}
	return &Client{
		Token:  token,
		ChatID: chatID,
		HTTP: &http.Client{
			Timeout: 10 * time.Second,
		},
	}, nil
}

func (c *Client) SendMessage(ctx context.Context, text string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return errors.New("empty telegram message")
	}
	u := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", c.Token)
	body := map[string]any{
		"chat_id": c.ChatID,
		"text":    text,
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("telegram sendMessage failed: status=%s", resp.Status)
	}
	return nil
}

