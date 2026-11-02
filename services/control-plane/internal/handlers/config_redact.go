package handlers

import "strings"

// RedactedValue replaces a secret in an API response. Clients that echo a
// config back (the dashboard's surface form) send it unchanged, and the
// write paths keep the stored secret for any field still equal to it
// (mergeRedacted). apps/web/lib/redacted.ts mirrors the constant.
const RedactedValue = "********"

// publicConfigKeys are config keys whose values are identifiers, not secrets,
// so list/get responses may return them. Everything else is masked: an
// allowlist fails safe when a connector or surface grows a new credential
// field. Compared case-insensitively with '_' and '-' removed.
var publicConfigKeys = map[string]bool{
	"email": true, "tenantemail": true, "username": true, "user": true, "smtpuser": true,
	"workspace": true, "workspaceid": true, "team": true, "teamid": true,
	"channel": true, "channelid": true, "defaultchannel": true, "chatid": true,
	"phonenumber": true, "phonenumberid": true, "fromnumber": true, "from": true,
	"accountsid": true, "messagingservicesid": true, "appid": true, "applicationid": true,
	"clientid": true, "botusername": true, "botname": true, "publickey": true,
	"region": true, "baseurl": true, "host": true, "smtphost": true, "port": true, "smtpport": true,
	"domain": true, "org": true, "organization": true, "owner": true, "repo": true,
	"project": true, "projectid": true, "calendarid": true, "databaseid": true,
	"name": true, "displayname": true, "mode": true, "allowedorigins": true, "vmid": true,
}

func normalizeConfigKey(k string) string {
	return strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(k))
}

// redactConfig returns a copy of cfg safe to send to any reader: public keys
// keep their value, every other non-empty value becomes RedactedValue, so a
// client can tell a field is set without learning it. Nested objects are
// redacted recursively.
func redactConfig(cfg map[string]any) map[string]any {
	if cfg == nil {
		return nil
	}
	out := make(map[string]any, len(cfg))
	for k, v := range cfg {
		switch tv := v.(type) {
		case map[string]any:
			out[k] = redactConfig(tv)
		case nil:
			out[k] = nil
		case string:
			if tv == "" || publicConfigKeys[normalizeConfigKey(k)] {
				out[k] = tv
			} else {
				out[k] = RedactedValue
			}
		default:
			if publicConfigKeys[normalizeConfigKey(k)] {
				out[k] = tv
			} else {
				out[k] = RedactedValue
			}
		}
	}
	return out
}

// mergeRedacted keeps the stored value for every field the client sent back
// still equal to RedactedValue, so saving a form that was prefilled from a
// redacted response does not overwrite secrets with the mask.
func mergeRedacted(incoming, stored map[string]any) map[string]any {
	if incoming == nil {
		return nil
	}
	out := make(map[string]any, len(incoming))
	for k, v := range incoming {
		switch tv := v.(type) {
		case string:
			if tv == RedactedValue {
				if prev, ok := stored[k]; ok {
					out[k] = prev
				}
				continue // a mask with nothing stored behind it is dropped
			}
		case map[string]any:
			prevMap, _ := stored[k].(map[string]any)
			out[k] = mergeRedacted(tv, prevMap)
			continue
		}
		out[k] = v
	}
	return out
}
