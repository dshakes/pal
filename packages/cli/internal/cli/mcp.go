package cli

// mcp.go — `pal mcp …`: the MCP server catalog, tenant (BYO) remote servers,
// per-agent attachments, and their credentials (ADR 0058). Secrets are only
// read from stdin / a pasted redirect and are never echoed.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/spf13/cobra"
)

type mcpCatalogServer struct {
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	Transport string `json:"transport"`
	AuthType  string `json:"authType"`
	Category  string `json:"category"`
}

type mcpTenantServer struct {
	Slug     string `json:"slug"`
	Name     string `json:"name"`
	URL      string `json:"url"`
	AuthType string `json:"authType"`
}

type mcpTool struct {
	Name            string `json:"name"`
	ToolName        string `json:"toolName,omitempty"`
	Description     string `json:"description"`
	AllowedByPolicy *bool  `json:"allowedByPolicy,omitempty"`
}

type mcpCredential struct {
	ServerSlug string `json:"serverSlug"`
	Kind       string `json:"kind"`
	Scope      string `json:"scope,omitempty"`
	Issuer     string `json:"issuer,omitempty"`
	ExpiresAt  string `json:"expiresAt,omitempty"`
	UpdatedAt  string `json:"updatedAt"`
}

func newMCPCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "mcp",
		Short: "Manage MCP servers: catalog, your own servers, agent attachments and credentials",
	}
	cmd.AddCommand(newMCPServersCommand(), newMCPAddCommand(), newMCPRemoveCommand(),
		newMCPAttachCommand(), newMCPDetachCommand(), newMCPToolsCommand(),
		newMCPTokenCommand(), newMCPLoginCommand(), newMCPCredsCommand())
	return cmd
}

// mcpGet fetches path and decodes the JSON response into out.
func mcpGet(path string, out any) error {
	resp, err := apiRaw("GET", path, nil)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(resp, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

// mcpSend sends a JSON body and decodes the response into out (may be nil).
func mcpSend(method, path string, body any, out any) error {
	var b []byte
	if body != nil {
		var err error
		if b, err = json.Marshal(body); err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
	}
	resp, err := apiRaw(method, path, b)
	if err != nil {
		return err
	}
	if out != nil && len(resp) > 0 {
		if err := json.Unmarshal(resp, out); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}

func mcpDone(cmd *cobra.Command, key, val, msg string) error {
	if isJSON() {
		return printJSON(map[string]any{key: val})
	}
	fmt.Fprintln(cmd.OutOrStdout(), msg)
	return nil
}

func newMCPServersCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "servers",
		Short: "List the MCP server catalog",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var list []mcpCatalogServer
			if err := mcpGet("/v1/mcp/servers", &list); err != nil {
				return err
			}
			if isJSON() {
				return printJSON(list)
			}
			if len(list) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "No MCP servers.")
				return nil
			}
			for _, s := range list {
				fmt.Fprintf(cmd.OutOrStdout(), "%s  %s  %s  auth=%s\n", s.Slug, s.Name, s.Transport, s.AuthType)
			}
			return nil
		},
	}
}

func newMCPAddCommand() *cobra.Command {
	var endpoint, auth, name string
	cmd := &cobra.Command{
		Use:   "add <slug>",
		Short: "Register your own remote MCP server",
		Long: "Register a remote (Streamable HTTP) MCP server for this workspace. Then attach it\n" +
			"to an agent with `pal mcp attach`; for --auth bearer run `pal mcp token <slug>`,\n" +
			"for --auth oauth run `pal mcp login <slug>`.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if endpoint == "" {
				return fmt.Errorf("--url is required")
			}
			switch auth {
			case "none", "bearer", "oauth":
			default:
				return fmt.Errorf("--auth must be none, bearer or oauth")
			}
			body := map[string]any{"slug": args[0], "url": endpoint, "authType": auth}
			if name != "" {
				body["name"] = name
			}
			var s mcpTenantServer
			if err := mcpSend("POST", "/v1/mcp/tenant-servers", body, &s); err != nil {
				return err
			}
			if isJSON() {
				return printJSON(s)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Registered %s  %s  auth=%s\n", s.Slug, s.URL, s.AuthType)
			return nil
		},
	}
	cmd.Flags().StringVar(&endpoint, "url", "", "server URL (https)")
	cmd.Flags().StringVar(&auth, "auth", "none", "none | bearer | oauth")
	cmd.Flags().StringVar(&name, "name", "", "display name")
	return cmd
}

func newMCPRemoveCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "remove <slug>",
		Short: "Remove one of your registered MCP servers",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := mcpSend("DELETE", "/v1/mcp/tenant-servers/"+url.PathEscape(args[0]), nil, nil); err != nil {
				return err
			}
			return mcpDone(cmd, "removed", args[0], "Server "+args[0]+" removed.")
		},
	}
}

func newMCPAttachCommand() *cobra.Command {
	var vmID string
	cmd := &cobra.Command{
		Use:   "attach <agent> <slug>",
		Short: "Attach an MCP server to an agent",
		Long:  "Attach a catalog or registered MCP server to an agent. stdio catalog servers need --vm, a running sandbox VM id; they never run on the host.",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			config := map[string]any{}
			if vmID != "" {
				config["vmId"] = vmID
			}
			body := map[string]any{"serverSlug": args[1], "config": config}
			if err := mcpSend("POST", "/v1/agents/"+url.PathEscape(args[0])+"/mcp-servers", body, nil); err != nil {
				return err
			}
			return mcpDone(cmd, "attached", args[1], fmt.Sprintf("Attached %s to %s.", args[1], args[0]))
		},
	}
	cmd.Flags().StringVar(&vmID, "vm", "", "running sandbox VM id (required for stdio servers)")
	return cmd
}

func newMCPDetachCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "detach <agent> <slug>",
		Short: "Detach an MCP server from an agent",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := "/v1/agents/" + url.PathEscape(args[0]) + "/mcp-servers/" + url.PathEscape(args[1])
			if err := mcpSend("DELETE", path, nil, nil); err != nil {
				return err
			}
			return mcpDone(cmd, "detached", args[1], fmt.Sprintf("Detached %s from %s.", args[1], args[0]))
		},
	}
}

func newMCPToolsCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "tools <agent> <slug>",
		Short: "List the live tools of an attached MCP server (also a connection test)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var res struct {
				Server string    `json:"server"`
				Tools  []mcpTool `json:"tools"`
			}
			path := "/v1/agents/" + url.PathEscape(args[0]) + "/mcp-servers/" + url.PathEscape(args[1]) + "/tools"
			if err := mcpGet(path, &res); err != nil {
				return err
			}
			if isJSON() {
				return printJSON(res)
			}
			if len(res.Tools) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "No tools.")
				return nil
			}
			for _, t := range res.Tools {
				name := t.ToolName
				if name == "" {
					name = t.Name
				}
				note := ""
				if t.AllowedByPolicy != nil && !*t.AllowedByPolicy {
					note = "  [blocked by policy]"
				}
				fmt.Fprintf(cmd.OutOrStdout(), "%s  %s%s\n", name, t.Description, note)
			}
			return nil
		},
	}
}

func newMCPTokenCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "token <slug>",
		Short: "Store a bearer token for an MCP server (read from stdin)",
		Long:  "Reads the token from one line of stdin so it never lands in shell history, e.g.\n  pbpaste | pal mcp token my-server",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			tok, err := readSecretStdin(cmd.InOrStdin())
			if err != nil {
				return err
			}
			if tok == "" {
				return fmt.Errorf("no token on stdin")
			}
			if err := mcpSend("PUT", "/v1/mcp/credentials/"+url.PathEscape(args[0]), map[string]string{"token": tok}, nil); err != nil {
				return err
			}
			return mcpDone(cmd, "stored", args[0], "Token stored for "+args[0]+".")
		},
	}
}

// parseOAuthRedirect extracts code and state from a pasted redirect URL, a
// "code=…&state=…" query string, or a bare "<code> <state>" pair.
func parseOAuthRedirect(in string) (code, state string, err error) {
	in = strings.TrimSpace(in)
	var q url.Values
	switch {
	case strings.Contains(in, "?"):
		u, perr := url.Parse(in)
		if perr != nil {
			return "", "", fmt.Errorf("parse redirect URL: %w", perr)
		}
		q = u.Query()
	case strings.Contains(in, "="):
		if q, err = url.ParseQuery(in); err != nil {
			return "", "", fmt.Errorf("parse query: %w", err)
		}
	default:
		if f := strings.Fields(in); len(f) == 2 {
			return f[0], f[1], nil
		}
	}
	if e := q.Get("error"); e != "" {
		return "", "", fmt.Errorf("authorization failed: %s", e)
	}
	if q.Get("code") == "" || q.Get("state") == "" {
		return "", "", fmt.Errorf("could not find code and state: paste the full redirect URL, or \"<code> <state>\"")
	}
	return q.Get("code"), q.Get("state"), nil
}

func newMCPLoginCommand() *cobra.Command {
	var scope, clientID string
	var noWait bool
	cmd := &cobra.Command{
		Use:   "login <slug>",
		Short: "Connect an OAuth MCP server (authorization code + PKCE)",
		Long: "Prints the authorization URL, then asks for the full redirect URL (or \"<code> <state>\")\n" +
			"your browser lands on and completes the connection. With --no-wait only the URL is printed.\n" +
			"A confidential client's secret is read from the PAL_MCP_CLIENT_SECRET environment variable.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"serverSlug": args[0]}
			if scope != "" {
				body["scope"] = scope
			}
			if clientID != "" {
				body["clientId"] = clientID
			}
			if s := envOrDefault("PAL_MCP_CLIENT_SECRET", ""); s != "" {
				body["clientSecret"] = s
			}
			var st struct {
				AuthorizationURL string `json:"authorizationUrl"`
				RedirectURI      string `json:"redirectUri"`
				ExpiresAt        string `json:"expiresAt"`
			}
			if err := mcpSend("POST", "/v1/mcp/oauth/start", body, &st); err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			if noWait {
				if isJSON() {
					return printJSON(st)
				}
				fmt.Fprintln(out, st.AuthorizationURL)
				return nil
			}
			fmt.Fprintf(out, "Open this URL and approve access:\n\n  %s\n\n", st.AuthorizationURL)
			fmt.Fprint(out, "Paste the full redirect URL (or \"<code> <state>\"): ")
			line, err := bufio.NewReader(cmd.InOrStdin()).ReadString('\n')
			if err != nil && err != io.EOF {
				return fmt.Errorf("read redirect: %w", err)
			}
			code, state, err := parseOAuthRedirect(line)
			if err != nil {
				return err
			}
			var res struct {
				Status     string `json:"status"`
				ServerSlug string `json:"serverSlug"`
			}
			if err := mcpSend("POST", "/v1/mcp/oauth/callback", map[string]string{"code": code, "state": state}, &res); err != nil {
				return err
			}
			if isJSON() {
				return printJSON(res)
			}
			fmt.Fprintf(out, "\nConnected %s.\n", args[0])
			return nil
		},
	}
	cmd.Flags().StringVar(&scope, "scope", "", "OAuth scope to request")
	cmd.Flags().StringVar(&clientID, "client-id", "", "pre-registered OAuth client id (skips dynamic registration)")
	cmd.Flags().BoolVar(&noWait, "no-wait", false, "print the authorization URL and exit")
	return cmd
}

func newMCPCredsCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "creds",
		Short: "List stored MCP credentials (metadata only; secrets are never shown)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			var list []mcpCredential
			if err := mcpGet("/v1/mcp/credentials", &list); err != nil {
				return err
			}
			if isJSON() {
				return printJSON(list)
			}
			if len(list) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "No MCP credentials.")
				return nil
			}
			for _, c := range list {
				line := fmt.Sprintf("%s  %s  updated %s", c.ServerSlug, c.Kind, c.UpdatedAt)
				if c.ExpiresAt != "" {
					line += "  expires " + c.ExpiresAt
				}
				fmt.Fprintln(cmd.OutOrStdout(), line)
			}
			return nil
		},
	}
}
