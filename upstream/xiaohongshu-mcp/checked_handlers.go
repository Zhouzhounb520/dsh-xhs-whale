// Distributed in the modified dsh-xhs-whale source snapshot. See MODIFICATIONS.md.
package main

import (
	"github.com/gin-gonic/gin"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
	"net/http"
)

func (s *AppServer) checkedCommentHandler(c *gin.Context) {
	var req xiaohongshu.CheckedCommentRequest
	if c.ShouldBindJSON(&req) != nil {
		respondError(c, 400, "INVALID_REQUEST", "评论参数无效", nil)
		return
	}
	b := newBrowser()
	defer b.Close()
	page := b.NewPage()
	defer page.Close()
	result := xiaohongshu.CheckedComment(c.Request.Context(), page, req)
	// Transport succeeded; the body distinguishes pre-submit failure from ambiguous submission.
	c.JSON(http.StatusOK, gin.H{"success": true, "data": result})
}
func (s *AppServer) resolveOwnerHandler(c *gin.Context) {
	var req struct {
		Query string `json:"query" binding:"required"`
	}
	if c.ShouldBindJSON(&req) != nil {
		respondError(c, 400, "INVALID_REQUEST", "主人标识无效", nil)
		return
	}
	b := newBrowser()
	defer b.Close()
	page := b.NewPage()
	defer page.Close()
	result, err := xiaohongshu.ResolveOwner(c.Request.Context(), page, req.Query)
	if err != nil {
		respondError(c, 409, "OWNER_NOT_RESOLVED", "主人用户尚未核实", "请提供个人主页链接，或在验证窗口完成登录后重试")
		return
	}
	respondSuccess(c, result, "主人用户已核实")
}
