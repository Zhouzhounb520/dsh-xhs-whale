// Distributed in the modified dsh-xhs-whale source snapshot. See MODIFICATIONS.md.
package xiaohongshu

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
)

// Local extension. A dry run prepares and validates the composer but never clicks Submit.
type MentionTarget struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Avatar string `json:"avatar"`
}
type CheckedCommentRequest struct {
	FeedID    string          `json:"feed_id" binding:"required"`
	Token     string          `json:"xsec_token" binding:"required"`
	Content   string          `json:"content" binding:"required"`
	AccountID string          `json:"account_id" binding:"required"`
	CommentID string          `json:"comment_id"`
	Mentions  []MentionTarget `json:"mentions"`
	Dry       *bool           `json:"dry"`
}
type CheckedCommentResult struct {
	Success           bool   `json:"success"`
	Dry               bool   `json:"dry"`
	Stage             string `json:"stage"`
	Certainty         string `json:"certainty"`
	Reason            string `json:"reason,omitempty"`
	Diagnostic        string `json:"diagnostic,omitempty"`
	CommentID         string `json:"comment_id,omitempty"`
	MentionVerified   bool   `json:"mention_verified"`
	MentionPrepared   bool   `json:"mention_prepared"`
	NeedsVerification bool   `json:"needs_verification,omitempty"`
}

var canonicalID = regexp.MustCompile(`^[a-fA-F0-9]{24}$`)

func visibleElement(page *rod.Page, selector string) (*rod.Element, error) {
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		els, err := page.Elements(selector)
		if err != nil {
			return nil, err
		}
		for _, el := range els {
			if ok, _ := el.Visible(); ok {
				hit, e := el.Eval(`() => {const r=this.getBoundingClientRect();const h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!h && (h===this || this.contains(h));}`)
				if e == nil && hit.Value.Bool() {
					return el, nil
				}
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return nil, fmt.Errorf("visible control not found")
}

// Keep hit-testing and coordinates in the same CSS viewport. Chromium builds may
// disagree with Rod's DOM.getNodeForLocation check; never click through an overlay.
func checkedClick(page *rod.Page, el *rod.Element) error {
	// A comment can exist in the DOM while its reply button is below the viewport.
	// Scroll the actual control (not the possibly very tall comment) before hit-testing.
	if err := el.ScrollIntoView(); err != nil {
		return err
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		r, err := el.Eval(`() => {
   const r=this.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2;
   const hit=document.elementFromPoint(x,y);
   return r.width>0 && r.height>0 && x>=0 && y>=0 && x<innerWidth && y<innerHeight && getComputedStyle(this).pointerEvents!=='none' && hit && (hit===this || this.contains(hit)) ? {x,y} : null;
  }`)
		if err != nil {
			return err
		}
		if !r.Value.Nil() {
			if err = page.Mouse.MoveTo(proto.Point{X: r.Value.Get("x").Num(), Y: r.Value.Get("y").Num()}); err != nil {
				return err
			}
			return page.Mouse.Click(proto.InputMouseButtonLeft, 1)
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("control is covered or outside viewport")
}

func CheckedComment(ctx context.Context, page *rod.Page, req CheckedCommentRequest) (result CheckedCommentResult) {
	result = CheckedCommentResult{Stage: "validate", Certainty: "not_sent", Dry: req.Dry == nil || *req.Dry}
	// A panic after clicking must never be described as definitely unsent.
	defer func() {
		if recover() != nil {
			result.Success = false
			result.Reason = "页面操作超时或异常；请按阶段核对"
		}
	}()
	totalLength := len([]rune(req.Content))
	for _, m := range req.Mentions {
		totalLength += len([]rune(m.Name)) + 2
	}
	if !canonicalID.MatchString(req.FeedID) || !canonicalID.MatchString(req.AccountID) || totalLength > 500 || strings.TrimSpace(req.Content) == "" || len(req.Mentions) > 1 {
		result.Reason = "笔记、正文或提及参数无效"
		return
	}
	for _, m := range req.Mentions {
		if !canonicalID.MatchString(m.ID) || m.Name == "" {
			result.Reason = "主人用户 ID 尚未核实"
			return
		}
	}
	page = page.Context(ctx).Timeout(100 * time.Second)
	result.Stage = "navigate"
	page.MustNavigate(makeFeedDetailURL(req.FeedID, req.Token))
	// Video/media connections may keep load pending; readiness is the actual composer.
	_ = page.Timeout(8 * time.Second).WaitLoad()
	loginOverlays, _ := page.Elements(".login-container")
	for _, overlay := range loginOverlays {
		if visible, _ := overlay.Visible(); visible {
			result.NeedsVerification = true
			result.Reason = "需要登录后才能评论"
			return
		}
	}
	if info, e := page.Info(); e == nil {
		if u, e := url.Parse(info.URL); e == nil && regexp.MustCompile(`(?i)captcha|verify|website-login`).MatchString(u.Path) {
			result.NeedsVerification = true
			result.Reason = "页面要求人工验证"
			return
		}
	}
	if err := checkPageAccessible(page); err != nil {
		result.Reason = "笔记不可访问、需要登录或验证"
		return
	}
	result.Stage = "activate"
	if req.CommentID != "" {
		target, err := findCommentElement(ctx, page, req.CommentID, "")
		if err != nil {
			result.Reason = "无法精确定位目标评论"
			return
		}
		reply, err := target.Element(".right .interactions .reply")
		if err != nil {
			result.Reason = "目标回复按钮不存在"
			return
		}
		if err = checkedClick(page, reply); err != nil {
			result.Reason = "无法激活回复输入框"
			return
		}
	} else {
		trigger, err := visibleElement(page, "div.input-box .not-active .inner span, div.input-box p.content-input")
		if err != nil {
			result.Reason = "没有可用评论输入框，帖子可能关闭评论"
			return
		}
		if err = checkedClick(page, trigger); err != nil {
			result.Reason = "无法激活评论输入框"
			_, hitErr := trigger.Interactable()
			result.Diagnostic = fmt.Sprintf("click=%T; hit=%T", err, hitErr)
			if covered, ok := hitErr.(*rod.CoveredError); ok {
				class, _ := covered.Attribute("class")
				if class != nil {
					result.Diagnostic += "; covered-class=" + *class
				}
				tag, _ := covered.Eval(`() => this.tagName`)
				if tag != nil {
					result.Diagnostic += "; covered-tag=" + tag.Value.Str()
				}
			}
			return
		}
	}
	input, err := visibleElement(page, `div.input-box .content-edit [contenteditable="true"]`)
	if err != nil {
		result.Reason = "评论编辑器未激活"
		return
	}
	result.Stage = "input"
	if err = input.Focus(); err != nil {
		result.Reason = "无法聚焦评论编辑器"
		return
	}
	empty := input.MustEval(`() => !this.innerText.trim()`).Bool()
	if !empty {
		result.Reason = "编辑器已有文字，未覆盖或提交"
		return
	}
	// Insert once, then read back the actual composer. Never assume typing succeeded.
	if err = page.InsertText(req.Content); err != nil {
		result.Reason = "输入正文失败"
		return
	}
	if input.MustEval(`txt => this.innerText.trim()===txt.trim()`, req.Content).Bool() != true {
		result.Reason = "输入内容与草稿不一致，已停止"
		return
	}
	for _, m := range req.Mentions {
		result.Stage = "mention"
		if err = page.InsertText(" "); err != nil {
			result.Reason = "无法输入提及查询"
			return
		}
		// Tribute listens to keyboard events; InsertText alone does not open its menu.
		if err = page.Keyboard.Type('@'); err != nil {
			result.Reason = "无法打开提及列表"
			return
		}
		// Select the platform's real user item, never inject a fabricated mention tag.
		selector := ".mention-container-new li"
		var candidate *rod.Element
		until := time.Now().Add(8 * time.Second)
		for time.Now().Before(until) {
			els, _ := page.Elements(selector)
			matches := []*rod.Element{}
			for _, el := range els {
				ok, _ := el.Visible()
				if !ok {
					continue
				}
				match, e := el.Eval(`(name,avatar) => {
 const img=this.querySelector('img'); const n=this.querySelector('.name');
 const path=s=>{try{return new URL(s).pathname}catch{return ''}};
 return !!avatar && n?.textContent.trim()===name && path(img?.src)===path(avatar);
}`, m.Name, m.Avatar)
				if e == nil && match.Value.Bool() {
					matches = append(matches, el)
				}
			}
			if len(matches) == 1 {
				candidate = matches[0]
			}
			if len(matches) > 1 {
				result.Reason = "提及候选有重复身份，未发送"
				return
			}
			if candidate != nil {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		if candidate == nil {
			result.Reason = "@ 候选中未找到已核实的主人，未提交普通 @ 文本"
			return
		}
		if err = checkedClick(page, candidate); err != nil {
			result.Reason = "无法选择主人提及项"
			return
		}
		verified := false
		for i := 0; i < 20; i++ {
			r, e := input.Eval(`name => Array.from(this.querySelectorAll('a[contenteditable="false"][data-set]')).some(e=>e.textContent==='@'+name)`, m.Name)
			if e == nil && r.Value.Bool() {
				verified = true
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if !verified {
			result.Reason = "编辑器未形成平台提及标签，未发送"
			return
		}
		result.MentionPrepared = true
	}
	result.Stage = "ready"
	submit, err := visibleElement(page, "div.bottom button.submit")
	if err != nil {
		result.Reason = "找不到发送按钮"
		return
	}
	ready, _ := submit.Eval(`() => !this.disabled && !this.classList.contains('disabled') && this.getAttribute('aria-disabled')!=='true'`)
	if !ready.Value.Bool() {
		result.Reason = "发送按钮不可用，未提交"
		return
	}
	if result.Dry {
		result.Success = true
		return
	}
	// Capture existing own comments so stale matching text cannot confirm a new submission.
	before := matchingComments(page, req)
	result.Stage = "submit"
	result.Certainty = "uncertain"
	if err = checkedClick(page, submit); err != nil {
		result.Reason = "提交动作未得到确认，请核对原帖"
		return
	}
	result.Stage = "confirm"
	for i := 0; i < 60; i++ {
		for _, id := range matchingComments(page, req) {
			prior := false
			for _, old := range before {
				if old == id {
					prior = true
				}
			}
			if !prior {
				result.Success = true
				result.CommentID = id
				result.Certainty = "sent"
				result.MentionVerified = len(req.Mentions) > 0
				return
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	result.Reason = "已点击提交，但 15 秒内未找到本账号的新评论，需核对；不会自动重发"
	return
}

//go:embed checked_comment_match.js
var checkedCommentMatchJS string

func matchingComments(page *rod.Page, req CheckedCommentRequest) []string {
	r, err := page.Eval(checkedCommentMatchJS, req.AccountID, req.Content, req.CommentID, req.Mentions)
	if err != nil {
		return nil
	}
	var out []string
	data, _ := json.Marshal(r.Value.Val())
	_ = json.Unmarshal(data, &out)
	return out
}

type ResolvedOwner struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	RedID  string `json:"red_id"`
	Avatar string `json:"avatar"`
}

func ResolveOwner(ctx context.Context, page *rod.Page, query string) (*ResolvedOwner, error) {
	query = strings.TrimSpace(query)
	page = page.Context(ctx).Timeout(60 * time.Second)
	if len(query) > 100 || query == "" {
		return nil, fmt.Errorf("主人标识无效")
	}
	ids := []string{}
	if canonicalID.MatchString(query) {
		ids = append(ids, query)
	} else {
		page = page.Context(ctx).Timeout(60 * time.Second)
		page.MustNavigate("https://www.xiaohongshu.com/search_result?keyword=" + url.QueryEscape(query))
		// Numeric red IDs appear in a dedicated search user card. Keep its profile ID,
		// nickname and avatar together rather than taking unrelated author links.
		for attempt := 0; attempt < 40; attempt++ {
			r, e := page.Eval(`q => {
 const cards=Array.from(document.querySelectorAll('.user-item-box'));
 const card=cards.find(e=>e.getClientRects().length && Array.from(e.querySelectorAll('.user-desc')).some(d=>d.textContent.trim()==='小红书号：'+q));
 if(!card) return null;
 const href=card.closest('a[href]')?.getAttribute('href')||'';
 const id=href.match(/\/user\/profile\/([a-f0-9]{24})/i)?.[1];
 return id ? {id,name:card.querySelector('.user-name')?.textContent.trim(),red_id:q,avatar:card.querySelector('img')?.src} : null;
}`, query)
			if e == nil && !r.Value.Nil() {
				var owner ResolvedOwner
				data, _ := json.Marshal(r.Value.Val())
				if json.Unmarshal(data, &owner) == nil && canonicalID.MatchString(owner.ID) && owner.Name != "" && owner.Avatar != "" {
					return &owner, nil
				}
			}
			time.Sleep(250 * time.Millisecond)
		}
		tab, err := page.ElementR("div,span", `^用户$`)
		if err != nil {
			return nil, fmt.Errorf("用户搜索不可用，请提供个人主页链接")
		}
		if err = tab.Click(proto.InputMouseButtonLeft, 1); err != nil {
			return nil, fmt.Errorf("无法打开用户搜索")
		}
		time.Sleep(2 * time.Second)
		links, _ := page.Elements(`a[href*="/user/profile/"]`)
		seen := map[string]bool{}
		for _, link := range links {
			if ok, _ := link.Visible(); !ok {
				continue
			}
			href, _ := link.Attribute("href")
			if href == nil {
				continue
			}
			id := regexp.MustCompile(`/user/profile/([a-fA-F0-9]{24})`).FindStringSubmatch(*href)
			if len(id) > 1 && !seen[id[1]] {
				ids = append(ids, id[1])
				seen[id[1]] = true
			}
			if len(ids) >= 3 {
				break
			}
		}
	}
	for _, id := range ids {
		p, err := NewUserProfileAction(page).UserProfile(ctx, id, "", TabNotes)
		if err != nil {
			continue
		}
		if query == id || p.UserBasicInfo.RedId == query {
			return &ResolvedOwner{ID: id, Name: p.UserBasicInfo.Nickname, RedID: p.UserBasicInfo.RedId, Avatar: p.UserBasicInfo.Images}, nil
		}
	}
	return nil, fmt.Errorf("未核实到该小红书号对应的用户，请提供个人主页链接；不会猜测同名账号")
}
