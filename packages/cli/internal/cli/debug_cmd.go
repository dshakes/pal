package cli

// `pal debug run|incident|eval` and `pal support [escalate]` (ADR 0059). Thin
// clients over /v1/debug/analyze and /v1/support/*. A proposal is only ever
// applied after a per-proposal y/N prompt on a TTY, and only if it stays inside
// the allowlist below (mirrors services/testdata/debug_action_allowlist.json;
// a test keeps them equal).

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/term"
)

type debugAllowed struct{ Kind, Method, Path string }

var debugActionAllowlist = []debugAllowed{
	{"rollback", "POST", `^/v1/agents/[A-Za-z0-9._%-]+/environments/(sandbox|staging|prod)/rollback$`},
	{"rollback", "POST", `^/v1/incidents/[0-9a-fA-F-]{36}/rollback$`},
	{"prompt_patch", "PATCH", `^/v1/agents/[A-Za-z0-9._%-]+$`},
	{"model_change", "PATCH", `^/v1/agents/[A-Za-z0-9._%-]+$`},
	{"eval_case", "POST", `^/v1/eval-suites$`},
	{"budget", "PUT", `^/v1/agents/[A-Za-z0-9._%-]+/budget$`},
	{"retry", "POST", `^/v1/runs$`},
}

var debugPreconditionAllowlist = []string{
	`^/v1/agents/[A-Za-z0-9._%-]+$`,
	`^/v1/agents/[A-Za-z0-9._%-]+/budget$`,
}

type debugReportDTO struct {
	Summary    string `json:"summary"`
	RootCause  string `json:"rootCause"`
	Confidence string `json:"confidence"`
	Grounded   bool   `json:"grounded"`
	Citations  []struct {
		Ref, Label, Detail string
	} `json:"citations"`
	Proposals []debugProposalDTO `json:"proposals"`
	Dropped   []struct {
		Kind   string `json:"kind"`
		Reason string `json:"reason"`
	} `json:"dropped"`
	Subject struct {
		Kind       string `json:"kind"`
		RunID      string `json:"runId"`
		IncidentID string `json:"incidentId"`
		AgentName  string `json:"agentName"`
		Case       string `json:"case"`
	} `json:"subject"`
	CostUSD float64 `json:"costUsd"`
}

type debugProposalDTO struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Title     string `json:"title"`
	Rationale string `json:"rationale"`
	Risk      string `json:"risk"`
	Action    *struct {
		Method         string `json:"method"`
		Path           string `json:"path"`
		Body           any    `json:"body"`
		IdempotencyKey string `json:"idempotencyKey"`
	} `json:"action"`
	Precondition *struct {
		Path   string         `json:"path"`
		Expect map[string]any `json:"expect"`
	} `json:"precondition"`
	Href string `json:"href"`
	Diff *struct {
		Field  string `json:"field"`
		Before string `json:"before"`
		After  string `json:"after"`
		Hunk   *struct {
			Offset        int    `json:"offset"`
			ContextBefore string `json:"contextBefore"`
			Removed       string `json:"removed"`
			Added         string `json:"added"`
			ContextAfter  string `json:"contextAfter"`
		} `json:"hunk"`
	} `json:"diff"`
	Preview  string `json:"preview"`
	FollowUp string `json:"followUp"`
}

// debugInteractive reports whether stdin AND stdout are terminals. A var so tests can force it.
var debugInteractive = func() bool {
	return term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
}

// checkDebugAction refuses any request outside the allowlist.
func checkDebugAction(kind, method, path string) error {
	for _, a := range debugActionAllowlist {
		if a.Kind == kind && a.Method == method && regexp.MustCompile(a.Path).MatchString(path) {
			return nil
		}
	}
	return fmt.Errorf("refusing %s %s: not an allowed %q action", method, path, kind)
}

func checkDebugPreconditionPath(path string) error {
	for _, p := range debugPreconditionAllowlist {
		if regexp.MustCompile(p).MatchString(path) {
			return nil
		}
	}
	return fmt.Errorf("refusing precondition GET %s: not allowed", path)
}

// debugValueEq compares an expected value with the live one: numbers
// numerically, everything else by string; nil (missing) reads as "".
func debugValueEq(want, got any) bool {
	if wf, ok := want.(float64); ok {
		gf, ok := got.(float64)
		return ok && wf == gf
	}
	str := func(v any) string {
		if v == nil {
			return ""
		}
		if s, ok := v.(string); ok {
			return s
		}
		return fmt.Sprint(v)
	}
	return str(want) == str(got)
}

// debugPreconditionHolds returns the first changed field, or "" when all match.
func debugPreconditionHolds(expect, live map[string]any) string {
	for k, w := range expect {
		if !debugValueEq(w, live[k]) {
			return k
		}
	}
	return ""
}

// Terminal escapes and control characters (except tab/newline) are stripped
// from everything the server sends before it is printed.
var (
	termEscRe  = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]`)
	termCtrlRe = regexp.MustCompile(`[\x00-\x08\x0b-\x1f\x7f\x{80}-\x{9f}]`)
)

func termSafe(s string) string {
	return termCtrlRe.ReplaceAllString(termEscRe.ReplaceAllString(s, ""), "")
}

// debugHunkMax bounds what the CLI will ask a person to review in a terminal.
const debugHunkMax = 8000

// checkPromptHunk proves the change on screen is the whole change: applying
// the shown hunk to the shown "before" must give exactly the prompt the PATCH
// sends. Otherwise (or if the hunk is too large to show in full) refuse.
func checkPromptHunk(p debugProposalDTO) error {
	d := p.Diff
	if d == nil || d.Hunk == nil {
		return fmt.Errorf("refusing: prompt patch has no reviewable hunk")
	}
	h := d.Hunk
	if len(h.Removed)+len(h.Added) > debugHunkMax {
		return fmt.Errorf("refusing: patch too large to review in a terminal; use the dashboard")
	}
	if h.Offset < 0 || h.Offset+len(h.Removed) > len(d.Before) || d.Before[h.Offset:h.Offset+len(h.Removed)] != h.Removed {
		return fmt.Errorf("refusing: hunk does not match the current prompt")
	}
	body, _ := p.Action.Body.(map[string]any)
	sent, _ := body["systemPrompt"].(string)
	if d.Before[:h.Offset]+h.Added+d.Before[h.Offset+len(h.Removed):] != sent || sent != d.After {
		return fmt.Errorf("refusing: the request would change more than the change shown")
	}
	if termSafe(h.Removed) != h.Removed || termSafe(h.Added) != h.Added {
		return fmt.Errorf("refusing: patch contains control characters")
	}
	return nil
}

func indent(s, pre string) string {
	return pre + strings.ReplaceAll(strings.TrimRight(s, "\n"), "\n", "\n"+pre)
}

func renderDebugReport(w io.Writer, r *debugReportDTO) {
	fmt.Fprintf(w, "Summary:    %s\n", termSafe(r.Summary))
	fmt.Fprintf(w, "Root cause: %s\n", termSafe(r.RootCause))
	fmt.Fprintf(w, "Confidence: %s\n", termSafe(r.Confidence))
	if !r.Grounded {
		fmt.Fprintln(w, "WARNING: ungrounded - the analysis cites no verified evidence; treat it as a guess.")
	}
	if len(r.Citations) > 0 {
		fmt.Fprintln(w, "\nEvidence:")
		for _, c := range r.Citations {
			fmt.Fprintf(w, "  [%s] %s\n", termSafe(c.Ref), termSafe(c.Label))
		}
	}
	for i, p := range r.Proposals {
		fmt.Fprintf(w, "\n#%d %s  (%s, risk: %s)\n", i+1, termSafe(p.Title), termSafe(p.Kind), termSafe(p.Risk))
		fmt.Fprintf(w, "   why: %s\n", termSafe(p.Rationale))
		switch d := p.Diff; {
		case d != nil && d.Hunk != nil:
			// The whole change, unclipped; only the surrounding context is cut.
			h := d.Hunk
			fmt.Fprintf(w, "   %s change at byte %d:\n", termSafe(d.Field), h.Offset)
			if h.ContextBefore != "" {
				fmt.Fprintf(w, "%s\n", indent(termSafe(h.ContextBefore), "     "))
			}
			if h.Removed != "" {
				fmt.Fprintf(w, "%s\n", indent(termSafe(h.Removed), "   - "))
			}
			fmt.Fprintf(w, "%s\n", indent(termSafe(h.Added), "   + "))
			if h.ContextAfter != "" {
				fmt.Fprintf(w, "%s\n", indent(termSafe(h.ContextAfter), "     "))
			}
		case d != nil:
			fmt.Fprintf(w, "   %s: %s -> %s\n", termSafe(d.Field), termSafe(d.Before), termSafe(d.After))
		}
		if p.Preview != "" {
			fmt.Fprintf(w, "   creates:\n%s\n", indent(termSafe(p.Preview), "     "))
		}
		if p.Action != nil {
			fmt.Fprintf(w, "   would send: %s %s\n", termSafe(p.Action.Method), termSafe(p.Action.Path))
		}
		if p.Kind == "policy" || (p.Action == nil && p.Href != "") {
			fmt.Fprintf(w, "   edit in the dashboard: %s (policy changes are never one-click)\n", termSafe(p.Href))
		}
		if p.FollowUp != "" {
			fmt.Fprintf(w, "   follow-up: %s\n", termSafe(p.FollowUp))
		}
	}
	if len(r.Dropped) > 0 {
		fmt.Fprintln(w, "\nDropped proposals:")
		for _, d := range r.Dropped {
			fmt.Fprintf(w, "  - %s: %s\n", termSafe(d.Kind), termSafe(d.Reason))
		}
	}
}

// applyDebugProposal validates and sends one proposal's action.
func applyDebugProposal(cmd *cobra.Command, p debugProposalDTO) error {
	a := p.Action
	if err := checkDebugAction(p.Kind, a.Method, a.Path); err != nil {
		return err
	}
	if p.Kind == "prompt_patch" {
		if err := checkPromptHunk(p); err != nil {
			return err
		}
	}
	if pc := p.Precondition; pc != nil {
		if err := checkDebugPreconditionPath(pc.Path); err != nil {
			return err
		}
		code, live, err := promoHTTP("GET", pc.Path, nil)
		if err != nil {
			return fmt.Errorf("precondition check: %w", err)
		}
		if code >= 400 {
			return fmt.Errorf("precondition check: GET %s: %d", pc.Path, code)
		}
		if f := debugPreconditionHolds(pc.Expect, live); f != "" {
			return fmt.Errorf("stale proposal: %s changed since the analysis; run pal debug again", f)
		}
	}
	code, out, err := promoHTTPKey(a.Method, a.Path, a.Body, a.IdempotencyKey)
	if err != nil {
		return err
	}
	if code >= 400 {
		return fmt.Errorf("%s %s: %d %s", a.Method, a.Path, code, firstStr(out["error"], out["code"]))
	}
	w := cmd.OutOrStdout()
	fmt.Fprintf(w, "applied: %s %s -> %d\n", a.Method, a.Path, code)
	if p.Kind == "eval_case" {
		id := firstStr(out["id"], out["suiteId"])
		fmt.Fprintf(w, "eval suite id: %s\n", id)
		fmt.Fprintf(w, "replay with: pal eval run --agent <agent> --suite %s   (POST /v1/eval-suites/%s/run)\n", id, id)
	}
	return nil
}

func debugAnalyze(cmd *cobra.Command, body map[string]any, asJSON bool) error {
	code, out, err := promoHTTP("POST", "/v1/debug/analyze", body)
	if err != nil {
		return err
	}
	if code >= 400 {
		return fmt.Errorf("debug analyze: %d %s", code, firstStr(out["code"], out["error"]))
	}
	w := cmd.OutOrStdout()
	if asJSON {
		b, _ := json.MarshalIndent(out, "", "  ")
		fmt.Fprintln(w, string(b))
		return nil
	}
	raw, _ := json.Marshal(out)
	var r debugReportDTO
	if err := json.Unmarshal(raw, &r); err != nil {
		return fmt.Errorf("decode report: %w", err)
	}
	renderDebugReport(w, &r)
	if !debugInteractive() {
		return nil
	}
	in := bufio.NewReader(cmd.InOrStdin())
	for i, p := range r.Proposals {
		if p.Action == nil {
			continue
		}
		fmt.Fprintf(w, "\nApply #%d %s? [y/N] ", i+1, termSafe(p.Title))
		line, rerr := in.ReadString('\n')
		if a := strings.ToLower(strings.TrimSpace(line)); a == "y" || a == "yes" {
			if err := applyDebugProposal(cmd, p); err != nil {
				fmt.Fprintf(cmd.ErrOrStderr(), "not applied: %v\n", err)
			}
		}
		if rerr != nil {
			break
		}
	}
	return nil
}

func newDebugCommand() *cobra.Command {
	var question string
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "debug",
		Short: "Ask the debug agent why a run, incident or eval case went wrong",
		Long: `Analyzes a run, incident or eval case and proposes fixes. On a terminal you are
asked per proposal whether to apply it; with --json or a non-terminal nothing
is ever applied.`,
	}
	f := cmd.PersistentFlags()
	f.StringVarP(&question, "question", "q", "", "optional question for the analysis")
	f.BoolVar(&asJSON, "json", false, "print the raw report as JSON (never applies)")
	sub := func(use, short string, n int, build func(a []string) map[string]any) *cobra.Command {
		return &cobra.Command{Use: use, Short: short, Args: cobra.ExactArgs(n),
			RunE: func(c *cobra.Command, a []string) error {
				b := build(a)
				if question != "" {
					b["question"] = question
				}
				return debugAnalyze(c, b, asJSON)
			}}
	}
	cmd.AddCommand(
		sub("run <run-id>", "Analyze a run", 1, func(a []string) map[string]any {
			return map[string]any{"kind": "run", "runId": a[0]}
		}),
		sub("incident <incident-id>", "Analyze an incident", 1, func(a []string) map[string]any {
			return map[string]any{"kind": "incident", "incidentId": a[0]}
		}),
		sub("eval <agent> <case>", "Analyze a failing eval case", 2, func(a []string) map[string]any {
			return map[string]any{"kind": "eval_case", "agentName": a[0], "case": a[1]}
		}),
	)
	return cmd
}

func newSupportCommand() *cobra.Command {
	var runID string
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "support \"<question>\"",
		Short: "Ask the PAL support agent (answers cite docs and your own data)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"question": args[0]}
			if runID != "" {
				body["runId"] = runID
			}
			code, out, err := promoHTTP("POST", "/v1/support/ask", body)
			if err != nil {
				return err
			}
			if code >= 400 {
				return fmt.Errorf("support ask: %d %s", code, firstStr(out["code"], out["error"]))
			}
			w := cmd.OutOrStdout()
			if asJSON {
				b, _ := json.MarshalIndent(out, "", "  ")
				fmt.Fprintln(w, string(b))
				return nil
			}
			renderSupportAnswer(w, out)
			return nil
		},
	}
	cmd.Flags().StringVar(&runID, "run", "", "run id to ground the answer in")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print the raw response as JSON")
	cmd.AddCommand(newSupportEscalateCommand())
	return cmd
}

func renderSupportAnswer(w io.Writer, out map[string]any) {
	fmt.Fprintln(w, firstStr(out["answer"]))
	if g, ok := out["grounded"].(bool); ok && !g {
		fmt.Fprintln(w, "\nWARNING: ungrounded - not backed by cited docs or data.")
	}
	items := func(k string) []map[string]any {
		var r []map[string]any
		a, _ := out[k].([]any)
		for _, v := range a {
			if m, ok := v.(map[string]any); ok {
				r = append(r, m)
			}
		}
		return r
	}
	if cs := items("citations"); len(cs) > 0 {
		fmt.Fprintln(w, "\nCited:")
		for _, c := range cs {
			fmt.Fprintf(w, "  [%s] %s\n", firstStr(c["ref"]), firstStr(c["label"]))
		}
	}
	if ds := items("docs"); len(ds) > 0 {
		fmt.Fprintln(w, "\nDocs:")
		for _, d := range ds {
			fmt.Fprintf(w, "  %s  %s\n", firstStr(d["title"]), firstStr(d["path"]))
		}
	}
	if as := items("actions"); len(as) > 0 {
		fmt.Fprintln(w, "\nSuggested:")
		for _, a := range as {
			switch k := firstStr(a["kind"]); k {
			case "debug_run":
				fmt.Fprintf(w, "  pal debug run %s\n", firstStr(a["runId"]))
			case "debug_incident":
				fmt.Fprintf(w, "  pal debug incident %s\n", firstStr(a["incidentId"]))
			default:
				fmt.Fprintf(w, "  %s %s\n", firstStr(a["label"], k), firstStr(a["href"]))
			}
		}
	}
	if e, _ := out["suggestEscalation"].(bool); e {
		fmt.Fprintln(w, "\nNot resolved? Run: pal support escalate \"<question>\" [--run <id> | --incident <id>]")
	}
}

func newSupportEscalateCommand() *cobra.Command {
	var runID, incidentID string
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "escalate \"<question>\"",
		Short: "Escalate to a human with a signed diagnostic digest",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if runID != "" && incidentID != "" {
				return errors.New("use only one of --run or --incident")
			}
			body := map[string]any{"question": args[0]}
			if runID != "" {
				body["runId"] = runID
			}
			if incidentID != "" {
				body["incidentId"] = incidentID
			}
			code, out, err := promoHTTP("POST", "/v1/support/escalations", body)
			if err != nil {
				return err
			}
			if code >= 400 {
				return fmt.Errorf("escalate: %d %s", code, firstStr(out["code"], out["error"]))
			}
			w := cmd.OutOrStdout()
			if asJSON {
				b, _ := json.MarshalIndent(out, "", "  ")
				fmt.Fprintln(w, string(b))
				return nil
			}
			fmt.Fprintf(w, "escalation id: %s\ndigest:        %s\nalgorithm:     %s\n",
				firstStr(out["id"]), firstStr(out["digest"]), firstStr(out["algorithm"]))
			return nil
		},
	}
	cmd.Flags().StringVar(&runID, "run", "", "run id to attach")
	cmd.Flags().StringVar(&incidentID, "incident", "", "incident id to attach")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print the raw response as JSON")
	return cmd
}
