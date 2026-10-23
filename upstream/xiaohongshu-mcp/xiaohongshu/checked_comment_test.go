// Distributed in the modified dsh-xhs-whale source snapshot. See MODIFICATIONS.md.
package xiaohongshu

import (
	"context"
	"strings"
	"testing"
)

func TestCheckedInvalidRequestNeverTouchesBrowser(t *testing.T) {
	for _, req := range []CheckedCommentRequest{
		{FeedID: "bad", Content: "hello", AccountID: "222222222222222222222222"},
		{FeedID: "333333333333333333333333", Content: "hello", AccountID: ""},
		{FeedID: "333333333333333333333333", Content: strings.Repeat("文", 499), AccountID: "222222222222222222222222", Mentions: []MentionTarget{{ID: "111111111111111111111111", Name: "测试主人"}}},
	} {
		result := CheckedComment(context.Background(), nil, req)
		if result.Success || result.Stage != "validate" || result.Certainty != "not_sent" || !result.Dry {
			t.Fatalf("invalid request: %+v", result)
		}
	}
}
