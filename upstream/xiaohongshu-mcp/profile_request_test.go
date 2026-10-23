// Distributed in the modified dsh-xhs-whale source snapshot. See MODIFICATIONS.md.
package main

import (
	"github.com/gin-gonic/gin/binding"
	"testing"
)

func TestCheckedProfileAllowsPublicUserIDWithoutToken(t *testing.T) {
	if err := binding.Validator.ValidateStruct(UserProfileRequest{UserID: "111111111111111111111111"}); err != nil {
		t.Fatalf("public profile requests should not require a fabricated token: %v", err)
	}
	if err := binding.Validator.ValidateStruct(UserProfileRequest{}); err == nil {
		t.Fatal("user identity is still required")
	}
}
