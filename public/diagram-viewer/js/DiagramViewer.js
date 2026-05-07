// ── Swift Bridge (defined first so postToSwift is always available) ────────
function postToSwift(msg) {
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.diagramEvents) {
        try { window.webkit.messageHandlers.diagramEvents.postMessage(msg); } catch(e) {}
    }
}

// ── Global error catcher ───────────────────────────────────────────────────
window.onerror = function(msg, src, line, col, err) {
    postToSwift({ type: 'error', message: 'onerror: ' + msg + ' @ ' + src + ':' + line });
    return false;
};

// ── Public API stubs (defined before any init that could throw) ────────────
window.renderDiagram = function(workspaceJson, viewKey) {
    postToSwift({ type: 'error', message: 'renderDiagram called before JS init completed' });
};
window.changeView = function(viewKey) {};

// ── State ──────────────────────────────────────────────────────────────────
var diagram = null;
var views   = [];
var viewKeys = [];
var viewsVisited;
var pendingViewKey = null;
var _thumbQueue = [];
var _thumbActive = false;
var _thumbRestoreKey = null;   // non-null → showDiagramView(key) after pass completes
// Tracks the name of the workspace most recently handed to renderDiagram so
// we can tell a same-workspace re-render (e.g. DSL save reparse — we want to
// preserve the user's current view) apart from a project switch (user clicked
// a different project card — we want the new workspace's home page).
var lastLoadedWorkspaceName = null;
// tooltip is the singleton created by structurizr-tooltip.js (const tooltip = new structurizr.ui.Tooltip())
// Re-declaring it here would conflict; just use it as a global.
var lasso;

try {
    structurizr.ui.initDarkMode('./css/structurizr-dark.css');
    viewsVisited = new structurizr.util.Stack();
    lasso        = $('#lasso');
} catch(e) {
    postToSwift({ type: 'error', message: 'Init error: ' + e.toString() });
}

var progressMessage = {
    show: function(html) { $('#progressMessage').html(html).removeClass('hidden'); },
    hide: function()     { $('#progressMessage').addClass('hidden'); }
};

// ── Public API (called by Swift) ──────────────────────────────────────────
window.renderDiagram = function(workspaceJson, viewKey) {
    try {
        var json = JSON.parse(workspaceJson);
        // Decide whether this is the same workspace re-rendered (DSL save
        // reparse) or a different workspace entirely (user switched projects).
        // Each sub-workspace in a multi-project build has a distinct `name`
        // field — "Crewing", "Jetstar ACARS Architecture", etc. — while an
        // unchanged DSL save produces the same name on both sides.
        var newName = (json && json.name) ? json.name : '';
        var isSameWorkspace = (lastLoadedWorkspaceName !== null
                               && lastLoadedWorkspaceName === newName);
        lastLoadedWorkspaceName = newName;

        structurizr.workspace = new structurizr.Workspace(json);

        if (diagram !== null && isSameWorkspace) {
            // ── Same workspace re-rendered (e.g. DSL save reparse) ─────────
            // Keep the existing Diagram instance and just refresh its views.
            // Try to preserve the user's current view when Swift passes an
            // empty viewKey (typical of a save flow).
            var restoreKey = viewKey;
            if (!restoreKey) {
                try {
                    var cur = diagram.getCurrentViewOrFilter();
                    if (cur && cur.key) { restoreKey = cur.key; }
                } catch(e) {}
            }

            views = structurizr.workspace.getViews();
            rebuildNavigation();

            if (restoreKey) {
                scheduleThumbnailGeneration(views.slice(), restoreKey);
            } else {
                showHome();
                scheduleThumbnailGeneration(views.slice());
            }
        } else {
            // ── First load, or cross-workspace switch ──────────────────────
            // Fully reset so workspaceLoaded() → init() builds a fresh Diagram
            // bound to the new structurizr.workspace.  Re-using the previous
            // Diagram across a workspace swap leaked internal state from the
            // old workspace (view caches, DOM references, onViewChanged
            // closures), which manifested as "clicking project B keeps
            // showing project A".
            cancelThumbnailGeneration();
            diagram = null;
            structurizr.diagram = null;
            // Clear the panels the old Diagram wrote into so the loading
            // transition doesn't flash the previous workspace's cards/sidebar.
            var homeCards = document.getElementById('home-cards');
            if (homeCards) homeCards.innerHTML = '';
            var nav = document.getElementById('diagramNavigation');
            if (nav) nav.innerHTML = '';

            pendingViewKey = viewKey || null;
            workspaceLoaded();
        }
    } catch(e) {
        postToSwift({ type: 'error', message: e.toString() });
        console.error('renderDiagram failed:', e);
    }
};

window.changeView = function(viewKey) {
    if (!viewKey) {
        cancelThumbnailGeneration();
        showHome();
        scheduleThumbnailGeneration(views.slice());
        postToSwift({ type: 'viewChanged', key: '' });
        return;
    }
    if (diagram !== null) {
        showDiagramView(viewKey);
    } else {
        pendingViewKey = viewKey;
    }
};

// ── Workspace loading ──────────────────────────────────────────────────────
function workspaceLoaded() {
    if (!structurizr.workspace.hasViews()) {
        $('#noViewsModal').modal('show');
        return;
    }
    views = structurizr.workspace.getViews();

    // Load themes with 2s timeout fallback (theme URLs are offline)
    var themeTimer = setTimeout(init, 2000);
    structurizr.ui.loadThemes(function() {
        clearTimeout(themeTimer);
        init();
    });
}

function init() {
    diagram = structurizr.diagram = new structurizr.ui.Diagram('diagram', false, diagramCreated);
    diagram.setEmbedded(false);
    diagram.setDarkMode(structurizr.ui.isDarkMode());
    diagram.setTooltip(tooltip);
    diagram.setLasso(lasso);
    diagram.setNavigationEnabled(true);
    diagram.onViewChanged(viewChanged);
    diagram.onAnimationStarted(animationStarted);
    diagram.onAnimationStopped(animationStopped);
    diagram.onElementDoubleClicked(elementDoubleClicked);
    diagram.onRelationshipDoubleClicked(relationshipDoubleClicked);

    initSizing();
    initFilter();
    initPerspectives();
    initKeyboardShortcuts();
    initAutoLayout();
    initQuickNavigation();
}

function diagramCreated() {
    initThumbnails();
    initExportList();

    if (pendingViewKey) {
        showDiagramView(pendingViewKey);
        pendingViewKey = null;
    } else {
        showHome();
        scheduleThumbnailGeneration(views.slice());
    }
    resize();
    postToSwift({ type: 'ready' });
}

// ── Show / hide panels ─────────────────────────────────────────────────────
function showHome() {
    cancelThumbnailGeneration();
    document.getElementById('home').classList.add('active');
    document.getElementById('diagramControls').classList.remove('active');
    // keep mainContent visible in DOM for dimensions
    document.getElementById('mainContent').style.visibility = 'hidden';
    document.getElementById('mainContent').style.pointerEvents = 'none';
    renderHomeContent();
}

function showDiagramView(viewKey) {
    cancelThumbnailGeneration();
    document.getElementById('home').classList.remove('active');
    document.getElementById('diagramControls').classList.add('active');
    document.getElementById('mainContent').style.visibility = '';
    document.getElementById('mainContent').style.pointerEvents = '';
    resize();
    progressMessage.show('<p>Loading…</p>');
    diagram.reset();
    diagram.changeView(viewKey, function() {
        progressMessage.hide();
    });
}

function resize() {
    var controlsHeight = 0;
    var controls = document.getElementById('diagramControls');
    if (controls && controls.classList.contains('active')) {
        controlsHeight = controls.offsetHeight;
    }
    document.getElementById('mainContent').style.top = controlsHeight + 'px';
    if (diagram) {
        diagram.resize();
        diagram.zoomToWidthOrHeight();
    }
}

// ── Sizing overrides (must match live server's initSizing) ────────────────
function initSizing() {
    diagram.getPossibleViewportWidth = function() {
        return document.getElementById('diagram-col').getBoundingClientRect().width;
    };
    diagram.getPossibleViewportHeight = function() {
        return document.getElementById('diagram-col').getBoundingClientRect().height;
    };
}

// ── Thumbnail nav panel ────────────────────────────────────────────────────
function initThumbnails() {
    viewKeys.length = 0;
    var html = '';
    var index = 1;
    views.forEach(function(view) {
        viewKeys.push(view.key);
        var id = 'diagram' + index;
        var title = structurizr.util.escapeHtml(structurizr.ui.getTitleForView(view));
        html += '<div id="' + id + 'Thumbnail" class="diagramThumbnail centered small">';
        // placeholder SVG until thumbnail is generated
        html += '<div class="diagramThumbImg" id="' + id + 'ThumbImg" style="height:80px;display:flex;align-items:center;justify-content:center;background:#f0f0f0;border-radius:2px;margin-bottom:4px">';
        html += '<svg width="24" height="24" fill="#ccc" viewBox="0 0 16 16"><rect x="1" y="1" width="6" height="6" rx="0.5"/><rect x="9" y="1" width="6" height="6" rx="0.5"/><rect x="1" y="9" width="6" height="6" rx="0.5"/><rect x="9" y="9" width="6" height="6" rx="0.5"/></svg>';
        html += '</div>';
        html += '<div>' + title + '<br><span class="small">#' + structurizr.util.escapeHtml(view.key) + '</span></div>';
        html += '</div>';
        index++;
    });
    $('#diagramNavigation').html(html);

    index = 1;
    views.forEach(function(view) {
        (function(v, idx) {
            document.getElementById('diagram' + idx + 'Thumbnail').onclick = function() {
                showDiagramView(v.key);
            };
        })(view, index);
        index++;
    });
}

function rebuildNavigation() {
    $('#diagramNavigation').empty();
    viewKeys.length = 0;
    viewsVisited = new structurizr.util.Stack();
    initThumbnails();
    quickNavigation.clear();
    initQuickNavigation();
    initExportList();
    initFilter();
    initPerspectives();
}

function selectDiagramByView(view) {
    $('.diagramThumbnail').removeClass('diagramThumbnailActive');
    var index = 1;
    views.forEach(function(v) {
        if (view.key === v.key) {
            $('#diagram' + index + 'Thumbnail').addClass('diagramThumbnailActive');
        }
        index++;
    });
    // scroll active thumbnail into view
    var panel = $('#diagramNavigationPanel');
    var thumb = $('.diagramThumbnailActive');
    if (panel.length && thumb.length) {
        if (thumb.offset().top < panel.offset().top) {
            thumb[0].scrollIntoView(true);
        } else if ((thumb.offset().top + thumb.height()) > (panel.offset().top + panel.height())) {
            thumb[0].scrollIntoView(false);
        }
    }
}

// ── Background thumbnail generation ───────────────────────────────────────
// restoreKey (optional): after all thumbnails are generated, call
// showDiagramView(restoreKey) instead of leaving mainContent hidden.
// Used when the workspace is refreshed while the user is viewing a diagram.
function scheduleThumbnailGeneration(viewList, restoreKey) {
    _thumbQueue      = viewList;
    _thumbActive     = true;
    _thumbRestoreKey = restoreKey || null;
    // Hide the canvas during the thumbnail pass so the user does not see
    // intermediate views cycling through as each thumbnail is rendered.
    document.getElementById('mainContent').style.visibility = 'hidden';
    document.getElementById('mainContent').style.pointerEvents = 'none';
    // Block interaction with the home cards AND the sidebar diagram-navigation
    // thumbnails while generation is in progress.  Without this the user can
    // click a card before the sidebar thumbnails are ready; showDiagramView
    // then cancels the pass, leaving placeholders in the sidebar they just
    // navigated into.  A progress message makes the wait explicit.
    _setThumbnailInteractionEnabled(false);
    progressMessage.show('<p>Preparing thumbnails…</p>');
    _generateNextThumbnail();
}

function cancelThumbnailGeneration() {
    _thumbActive     = false;
    _thumbQueue      = [];
    _thumbRestoreKey = null;
    _setThumbnailInteractionEnabled(true);
    progressMessage.hide();
}

// Enable/disable clicks on the thumbnail-containing panels so we can block
// premature navigation during a generation pass.  Applied to #home-cards
// (workspace home) and #diagramNavigation (diagram-view sidebar).
function _setThumbnailInteractionEnabled(enabled) {
    var value = enabled ? '' : 'none';
    var cards = document.getElementById('home-cards');
    if (cards) cards.style.pointerEvents = value;
    var nav = document.getElementById('diagramNavigation');
    if (nav) nav.style.pointerEvents = value;
}

function _generateNextThumbnail() {
    if (!_thumbActive || _thumbQueue.length === 0) {
        _thumbActive = false;
        progressMessage.hide();
        _setThumbnailInteractionEnabled(true);
        // Notify Swift that this workspace's thumbnail pass has completed.
        // Used by the project-card pre-render pipeline to advance to the next
        // workspace once it has collected all of this one's view thumbnails.
        postToSwift({
            type: 'thumbnailsReady',
            workspaceName: (structurizr.workspace && structurizr.workspace.name) || ''
        });
        if (_thumbRestoreKey) {
            // Workspace was refreshed while viewing a diagram — restore it now
            // that all sidebar thumbnails have been regenerated.
            var key = _thumbRestoreKey;
            _thumbRestoreKey = null;
            showDiagramView(key);
        } else {
            // Home-page mode: keep mainContent hidden (home panel is shown).
            document.getElementById('mainContent').style.visibility = 'hidden';
            document.getElementById('mainContent').style.pointerEvents = 'none';
        }
        return;
    }

    // Make diagram canvas visible (needed for SVG export) while keeping
    // pointer events disabled so the user cannot interact during the pass.
    document.getElementById('mainContent').style.visibility = 'visible';
    document.getElementById('mainContent').style.pointerEvents = 'none';
    resize();

    var view = _thumbQueue.shift();
    var idx  = viewKeys.indexOf(view.key) + 1;

    diagram.reset();
    diagram.changeView(view.key, function() {
        try {
            var result  = diagram.exportCurrentDiagramToSVG({ metadata: false, crop: false });
            var markup  = (result && result.markup) ? result.markup : result;
            if (markup && markup.length > 80) {
                var uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
                var container = document.getElementById('diagram' + idx + 'ThumbImg');
                if (container) {
                    container.innerHTML = '<img src="' + uri + '" style="max-width:100%;max-height:80px;object-fit:contain;">';
                }
                // Also update home page card if present
                var homeThumb = document.getElementById('home-thumb-' + escapeId(view.key));
                if (homeThumb) {
                    homeThumb.innerHTML = '<img src="' + uri + '" style="max-width:100%;max-height:130px;object-fit:contain;">';
                }
                // Post the freshly-generated thumbnail to Swift so the native
                // project-card view can display a real Structurizr-rendered
                // thumbnail rather than a SwiftUI approximation (which can't
                // handle auto-layout views where elements sit at 0,0).
                postToSwift({
                    type: 'thumbnailGenerated',
                    workspaceName: (structurizr.workspace && structurizr.workspace.name) || '',
                    viewKey: view.key,
                    dataURI: uri
                });
            }
        } catch(e) {
            console.log('thumbnail error for ' + view.key + ':', e);
        }
        setTimeout(_generateNextThumbnail, 30);
    });
}

// ── Home page rendering ────────────────────────────────────────────────────
function renderHomeContent() {
    document.getElementById('home-title').textContent = structurizr.workspace.name || 'Workspace';
    var desc = structurizr.workspace.description || '';
    var descEl = document.getElementById('home-description');
    descEl.textContent = desc;
    descEl.style.display = desc ? '' : 'none';

    var cards = document.getElementById('home-cards');
    cards.innerHTML = '';

    if (!views || views.length === 0) {
        document.getElementById('home-empty').classList.remove('hidden');
        return;
    }
    document.getElementById('home-empty').classList.add('hidden');

    views.forEach(function(view) {
        var title = view.title || view.key;
        var type  = view.type  || '';
        var idx   = viewKeys.indexOf(view.key) + 1;

        // Check if thumbnail already generated in nav panel
        var existingThumb = document.getElementById('diagram' + idx + 'ThumbImg');
        var thumbHTML;
        if (existingThumb) {
            var img = existingThumb.querySelector('img');
            thumbHTML = img
                ? '<img src="' + img.src + '" style="max-width:100%;max-height:130px;object-fit:contain;">'
                : defaultThumbSVG();
        } else {
            thumbHTML = defaultThumbSVG();
        }

        var card = document.createElement('div');
        card.className = 'workspaceSummary';
        card.innerHTML =
            '<div class="ws-name">' + escapeHtml(title) + '</div>' +
            '<div class="ws-type">[' + escapeHtml(type) + '] #' + escapeHtml(view.key) + '</div>' +
            '<div class="workspaceThumbnail" id="home-thumb-' + escapeId(view.key) + '">' + thumbHTML + '</div>';

        card.addEventListener('click', (function(v) {
            return function() { showDiagramView(v.key); };
        })(view));

        cards.appendChild(card);
    });
}

function defaultThumbSVG() {
    return '<svg width="40" height="40" viewBox="0 0 16 16" fill="#ccc">' +
        '<rect x="1" y="1" width="6" height="6" rx="0.5"/><rect x="9" y="1" width="6" height="6" rx="0.5"/>' +
        '<rect x="1" y="9" width="6" height="6" rx="0.5"/><rect x="9" y="9" width="6" height="6" rx="0.5"/>' +
        '</svg>';
}

function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escapeId(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── View changed callback ──────────────────────────────────────────────────
function viewChanged(key) {
    // Suppress all side-effects (including Swift notification) while the
    // background thumbnail pass is cycling through views.  The thumbnail
    // callbacks handle everything they need internally.
    if (_thumbActive) { return; }

    $('#keyModal').modal('hide');

    var view = structurizr.workspace.findViewByKey(key);
    if (!view) return;

    if (viewsVisited.peek() !== key) { viewsVisited.push(key); }
    $('.backButton').attr('disabled', viewsVisited.count() === 1);

    selectDiagramByView(view);

    // Animation buttons
    if (view.type === 'Dynamic' || (view.animations && view.animations.length > 1)) {
        $('.dynamicDiagramButton').removeClass('hidden');
        $('.stepBackwardAnimationButton').attr('disabled', true);
        $('.startAnimationButton').attr('disabled', false);
        $('.stopAnimationButton').attr('disabled', true);
        $('.stepForwardAnimationButton').attr('disabled', false);
    } else {
        $('.dynamicDiagramButton').addClass('hidden');
    }

    postToSwift({ type: 'viewChanged', key: key });

    diagram.resize();
    diagram.zoomToWidthOrHeight();
}

// ── Back navigation ────────────────────────────────────────────────────────
function back() {
    if (viewsVisited.count() > 1) {
        viewsVisited.pop();
        var key = viewsVisited.peek();
        showDiagramView(key);
    }
}

// ── Animation ──────────────────────────────────────────────────────────────
function animationStarted() {
    $('.startAnimationButton').attr('disabled', true);
    $('.stopAnimationButton').attr('disabled', false);
    $('.stepForwardAnimationButton').attr('disabled', true);
    $('.stepBackwardAnimationButton').attr('disabled', true);
}

function animationStopped() {
    $('.startAnimationButton').attr('disabled', false);
    $('.stopAnimationButton').attr('disabled', true);
    $('.stepForwardAnimationButton').attr('disabled', false);
    $('.stepBackwardAnimationButton').attr('disabled', false);
}

function startAnimation() { diagram.startAnimation(); }
function stopAnimation()  { diagram.stopAnimation();  }
function stepForwardInAnimation()  { diagram.stepForwardInAnimation();  }
function stepBackwardInAnimation() { diagram.stepBackwardInAnimation(); }

// ── Perspectives ───────────────────────────────────────────────────────────
function initPerspectives() {
    if (!structurizr.workspace) return;
    var names = structurizr.workspace.getPerspectiveNames();
    if (names.length > 0) {
        $('#perspectivesOnButton').removeClass('hidden');
    } else {
        $('#perspectivesOnButton').addClass('hidden');
        $('#perspectivesOffButton').addClass('hidden');
    }
}

function openPerspectivesModal() {
    var names = structurizr.workspace.getPerspectiveNames();
    if (names.length === 0) return;
    var options = [{ label: '(none)', value: '' }].concat(
        names.map(function(n) { return { label: n, value: n }; })
    );
    openNavigationModal(options, diagram.getPerspective(), function(perspective) {
        if (perspective.length > 0) {
            diagram.showPerspective(perspective);
            tooltip.disable();
            toggleTooltip();
            $('#perspectivesOnButton').addClass('hidden');
            $('#perspectivesOffButton').removeClass('hidden').attr('title', 'Perspective: ' + perspective);
        } else {
            if (diagram.hasPerspective()) {
                diagram.clearPerspective();
                tooltip.enable();
                toggleTooltip();
                $('#perspectivesOnButton').removeClass('hidden');
                $('#perspectivesOffButton').addClass('hidden').attr('title', 'Perspectives');
            }
        }
    });
}

// ── Filter ─────────────────────────────────────────────────────────────────
function initFilter() {
    if (!structurizr.workspace) return;
    var tags = structurizr.workspace.getUserDefinedTags();
    if (tags.length === 0) {
        $('#filterOnButton').addClass('hidden');
        return;
    }
    $('#filterOnButton').removeClass('hidden');

    var filter = diagram ? diagram.getFilter() : { tags: tags, active: false };
    filter.tags = tags;
    if (diagram) diagram.setFilter(filter);

    var selector = document.getElementById('tagSelector');
    selector.innerHTML = '';

    tags.forEach(function(tag) {
        var span = document.createElement('span');
        span.className = 'tag tagOn';
        span.textContent = tag;
        span.onclick = function() {
            if (!diagram) return;
            var f = diagram.getFilter();
            var idx = f.tags.indexOf(tag);
            if (idx > -1) { f.tags.splice(idx, 1); span.className = 'tag tagOff'; }
            else           { f.tags.push(tag);       span.className = 'tag tagOn'; }
            diagram.setFilter(f);
        };
        selector.appendChild(span);
    });

    $('#deselectAllTagsButton').off('click').on('click', function() {
        if (!diagram) return;
        var f = diagram.getFilter(); f.tags = []; diagram.setFilter(f);
        $('.tag').removeClass('tagOn').addClass('tagOff');
    });
    $('#selectAllTagsButton').off('click').on('click', function() {
        if (!diagram) return;
        var f = diagram.getFilter(); f.tags = tags.slice(); diagram.setFilter(f);
        $('.tag').removeClass('tagOff').addClass('tagOn');
    });
    $('#deactivateFilter').off('click').on('click', function() {
        if (!diagram) return;
        diagram.filterOff();
        $('#filterOnButton').removeClass('hidden');
        $('#filterOffButton').addClass('hidden');
        $('#filterModal').modal('hide');
    });
    $('#activateFilter').off('click').on('click', function() {
        $('#filterModal').modal('hide');
    });
}

function openFilterModal() {
    $('#filterModal').modal('show');
}

// ── Tooltip toggle ─────────────────────────────────────────────────────────
function toggleTooltip() {
    if (tooltip.isEnabled()) {
        tooltip.disable();
        $('.diagramTooltipOnButton').removeClass('hidden');
        $('.diagramTooltipOffButton').addClass('hidden');
    } else {
        tooltip.enable();
        $('.diagramTooltipOnButton').addClass('hidden');
        $('.diagramTooltipOffButton').removeClass('hidden');
    }
}

// ── Diagram key ────────────────────────────────────────────────────────────
function showKey() {
    if (diagram && diagram.getCurrentView().type !== structurizr.constants.IMAGE_VIEW_TYPE) {
        $('#diagramKey').html(diagram.exportCurrentDiagramKeyToSVG());
        $('#keyModal').modal('show');
    }
}

// ── Auto layout ────────────────────────────────────────────────────────────
var AUTOLAYOUT_RANK_DIRECTION   = 'structurizr/autolayout/rank-direction';
var AUTOLAYOUT_RANK_SEPARATION  = 'structurizr/autolayout/rank-separation';
var AUTOLAYOUT_NODE_SEPARATION  = 'structurizr/autolayout/node-separation';
var AUTOLAYOUT_EDGE_SEPARATION  = 'structurizr/autolayout/edge-separation';
var AUTOLAYOUT_VERTICES         = 'structurizr/autolayout/vertices';

function initAutoLayout() {
    var rankDir = structurizr.util.getItemFromLocalStorage(AUTOLAYOUT_RANK_DIRECTION,  structurizr.ui.DEFAULT_AUTOLAYOUT_RANK_DIRECTION);
    var rankSep = structurizr.util.getItemFromLocalStorage(AUTOLAYOUT_RANK_SEPARATION, '' + structurizr.ui.DEFAULT_AUTOLAYOUT_RANK_SEPARATION);
    var nodeSep = structurizr.util.getItemFromLocalStorage(AUTOLAYOUT_NODE_SEPARATION, '' + structurizr.ui.DEFAULT_AUTOLAYOUT_NODE_SEPARATION);
    var edgeSep = structurizr.util.getItemFromLocalStorage(AUTOLAYOUT_EDGE_SEPARATION, '' + structurizr.ui.DEFAULT_AUTOLAYOUT_EDGE_SEPARATION);
    var verts   = structurizr.util.getItemFromLocalStorage(AUTOLAYOUT_VERTICES,        '' + structurizr.ui.DEFAULT_AUTOLAYOUT_VERTICES);
    $('#autoLayoutRankDirection').val(rankDir);
    $('#autoLayoutRankSeparation').val(rankSep);
    $('#autoLayoutNodeSeparation').val(nodeSep);
    $('#autoLayoutEdgeSeparation').val(edgeSep);
    $('#autoLayoutVertices').prop('checked', verts === 'true');
}

$('#runAutoLayoutButton').on('click', function() {
    var rankDir = $('#autoLayoutRankDirection').val();
    var rankSep = parseInt($('#autoLayoutRankSeparation').val());
    var nodeSep = parseInt($('#autoLayoutNodeSeparation').val());
    var edgeSep = parseInt($('#autoLayoutEdgeSeparation').val());
    var verts   = $('#autoLayoutVertices').is(':checked');
    structurizr.util.setItemInLocalStorage(AUTOLAYOUT_RANK_DIRECTION,  rankDir);
    structurizr.util.setItemInLocalStorage(AUTOLAYOUT_RANK_SEPARATION, rankSep);
    structurizr.util.setItemInLocalStorage(AUTOLAYOUT_NODE_SEPARATION, nodeSep);
    structurizr.util.setItemInLocalStorage(AUTOLAYOUT_EDGE_SEPARATION, edgeSep);
    structurizr.util.setItemInLocalStorage(AUTOLAYOUT_VERTICES,        verts);
    diagram.applyAutomaticLayout(rankDir, rankSep, nodeSep, edgeSep, verts);
    $('#autoLayoutModal').modal('hide');
});

// ── Quick navigation ───────────────────────────────────────────────────────
function initQuickNavigation() {
    quickNavigation.clear();
    views.forEach(function(view) {
        var title = structurizr.util.escapeHtml(structurizr.ui.getTitleForView(view));
        quickNavigation.addHandler(
            title + ' <span class="viewKey">(#' + structurizr.util.escapeHtml(view.key) + ')</span>',
            (function(v) { return function() { showDiagramView(v.key); }; })(view)
        );
    });
    quickNavigation.onOpen(function()  { if (diagram) diagram.setKeyboardShortcutsEnabled(false); });
    quickNavigation.onClose(function() { if (diagram) diagram.setKeyboardShortcutsEnabled(true);  });
}

// ── Export ─────────────────────────────────────────────────────────────────
function initExportList() {
    var list = $('#exportViewList');
    list.empty();
    views.forEach(function(view) {
        list.append($('<option>').val(view.key).text(structurizr.ui.getTitleForView(view)));
    });
    list.attr('size', Math.min(8, views.length));
}

function exportSelectedViews(format) {
    var selectedKeys = $('#exportViewList').val();
    if (!selectedKeys || selectedKeys.length === 0) return;

    var options = {
        metadata: $('#exportMetadata').is(':checked'),
        crop:     $('#exportCrop').is(':checked')
    };

    var queue        = selectedKeys.slice();
    var total        = queue.length;
    var originalKey  = (diagram.getCurrentViewOrFilter() || {}).key || null;
    var exportedCount = 0;

    // Lock the modal buttons + disable card clicks so the user doesn't race
    // the sequential export pipeline.
    var svgBtn = document.getElementById('exportSvgButton');
    var pngBtn = document.getElementById('exportPngButton');
    if (svgBtn) svgBtn.disabled = true;
    if (pngBtn) pngBtn.disabled = true;

    progressMessage.show('<p>Exporting ' + total + ' diagram' + (total === 1 ? '' : 's') + '…</p>');

    function finish() {
        progressMessage.hide();
        if (svgBtn) svgBtn.disabled = false;
        if (pngBtn) pngBtn.disabled = false;
        postToSwift({ type: 'exportCompleted', count: exportedCount, format: format });
        // Dismiss the modal, then restore the view the user was looking at.
        try { $('#exportModal').modal('hide'); } catch(e) {}
        if (originalKey) {
            diagram.reset();
            diagram.changeView(originalKey);
        }
    }

    // SVG → Swift: post as a URL-encoded data URI.  Swift decodes and writes
    // <viewKey>.svg into <project>/<summaryId>/images/.
    function postSvg(key, svgMarkup) {
        var uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgMarkup);
        postToSwift({
            type: 'exportDiagram',
            viewKey: key,
            format: 'svg',
            dataURI: uri
        });
        exportedCount++;
    }

    // PNG → Swift: rasterise the SVG through a hidden <canvas> at 2× the
    // SVG's natural size so exported PNGs look sharp, then post the PNG data
    // URI.  An <img> backed by a data: URL is not tainted, so toDataURL works.
    function rasterizeSvgToPng(svgMarkup, callback) {
        var img = new Image();
        var svgUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgMarkup);
        img.onload = function() {
            try {
                // Fallback size if the SVG has no intrinsic width/height.
                var w = img.naturalWidth  || img.width  || 1600;
                var h = img.naturalHeight || img.height || 1200;
                var scale = 2;
                var canvas = document.createElement('canvas');
                canvas.width  = Math.max(1, Math.round(w * scale));
                canvas.height = Math.max(1, Math.round(h * scale));
                var ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                callback(canvas.toDataURL('image/png'));
            } catch (e) {
                console.log('PNG rasterise error:', e);
                callback(null);
            }
        };
        img.onerror = function() { callback(null); };
        img.src = svgUri;
    }

    function exportNext() {
        if (queue.length === 0) { finish(); return; }
        var key  = queue.shift();
        var view = structurizr.workspace.findViewByKey(key);
        if (!view) { exportNext(); return; }

        diagram.reset();
        diagram.changeView(key, function() {
            try {
                var result = diagram.exportCurrentDiagramToSVG(options);
                var svgMarkup = (result && result.markup) ? result.markup : result;

                if (!svgMarkup || svgMarkup.length < 40) {
                    console.log('export: empty SVG for', key);
                    exportNext();
                    return;
                }

                if (format === 'svg') {
                    postSvg(key, svgMarkup);
                    setTimeout(exportNext, 20);
                } else if (format === 'png') {
                    rasterizeSvgToPng(svgMarkup, function(pngDataURI) {
                        if (pngDataURI) {
                            postToSwift({
                                type: 'exportDiagram',
                                viewKey: key,
                                format: 'png',
                                dataURI: pngDataURI
                            });
                            exportedCount++;
                        }
                        setTimeout(exportNext, 20);
                    });
                } else {
                    exportNext();
                }
            } catch (e) {
                console.log('export error for', key, ':', e);
                exportNext();
            }
        });
    }

    exportNext();
}

// ── Element double-click drill-down ───────────────────────────────────────
function elementDoubleClicked(evt, elementId) {
    var element = structurizr.workspace.findElementById(elementId);
    if (!element) return;

    if (evt.altKey && element.url) { navigateToUrl(element.url); return; }

    var options = [];
    var relViews = [];

    if (element.type === structurizr.constants.SOFTWARE_SYSTEM_ELEMENT_TYPE) {
        var curr = diagram.getCurrentView();
        if (curr.type === structurizr.constants.SYSTEM_LANDSCAPE_VIEW_TYPE || curr.softwareSystemId !== element.id) {
            relViews = structurizr.workspace.findSystemContextViewsForSoftwareSystem(element.id);
            if (relViews.length === 0) relViews = structurizr.workspace.findContainerViewsForSoftwareSystem(element.id);
        } else if (curr.type === structurizr.constants.SYSTEM_CONTEXT_VIEW_TYPE) {
            relViews = structurizr.workspace.findContainerViewsForSoftwareSystem(element.id);
        }
    } else if (element.type === structurizr.constants.CONTAINER_ELEMENT_TYPE) {
        relViews = structurizr.workspace.findComponentViewsForContainer(element.id);
    } else if (element.type === structurizr.constants.SOFTWARE_SYSTEM_INSTANCE_ELEMENT_TYPE) {
        relViews = structurizr.workspace.findSystemContextViewsForSoftwareSystem(element.softwareSystemId);
    } else if (element.type === structurizr.constants.CONTAINER_INSTANCE_ELEMENT_TYPE) {
        relViews = structurizr.workspace.findComponentViewsForContainer(element.containerId);
    }

    relViews = relViews.concat(structurizr.workspace.findDynamicViewsForElement(element.id));
    relViews = relViews.concat(structurizr.workspace.findImageViewsForElement(element.id));

    relViews.forEach(function(v) {
        options.push({ value: v.key, label: structurizr.ui.getTitleForView(v) + ' (#' + v.key + ')' });
    });

    if (element.url) {
        options.push({ value: element.url, label: element.url });
    }

    if (options.length === 1) {
        handleNavigationOption(options[0].value);
    } else if (options.length > 1) {
        openNavigationModal(options, undefined, handleNavigationOption);
    }
}

function relationshipDoubleClicked(evt, relationshipId) {
    var rel = structurizr.workspace.findRelationshipById(relationshipId);
    if (rel && rel.url) { navigateToUrl(rel.url); }
}

function handleNavigationOption(value) {
    var view = structurizr.workspace.findViewByKey(value);
    if (view) {
        showDiagramView(view.key);
    } else {
        navigateToUrl(value);
    }
}

function navigateToUrl(url) {
    if (url && url.indexOf('#') === 0) {
        var key = url.substring(1);
        var v = structurizr.workspace.findViewByKey(key);
        if (v) { showDiagramView(v.key); return; }
    }
    if (url) postToSwift({ type: 'openUrl', url: url });
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
function initKeyboardShortcuts() {
    diagram.onkeydown(function(e) {
        var LEFT=37, UP=38, RIGHT=39, DOWN=40;
        if (diagram.isNavigationEnabled()) {
            if (e.which === LEFT || e.which === UP) {
                var idx = viewKeys.indexOf(diagram.getCurrentViewOrFilter().key);
                if (idx > 0) showDiagramView(viewKeys[idx - 1]);
                e.preventDefault();
            } else if (e.which === RIGHT || e.which === DOWN) {
                var idx2 = viewKeys.indexOf(diagram.getCurrentViewOrFilter().key);
                if (idx2 < viewKeys.length - 1) showDiagramView(viewKeys[idx2 + 1]);
                e.preventDefault();
            } else if (e.which === 8 || e.which === 27) { // backspace / esc
                back();
            }
        }
    });

    diagram.onkeypress(function(e) {
        switch(e.which) {
            case 43: case 61: diagram.zoomIn();           e.preventDefault(); break; // +/=
            case 45:          diagram.zoomOut();          e.preventDefault(); break; // -
            case 119:         diagram.zoomFitWidth();     e.preventDefault(); break; // w
            case 104:         diagram.zoomFitHeight();    e.preventDefault(); break; // h
            case 99:          diagram.zoomFitContent();   e.preventDefault(); break; // c
            case 102:         structurizr.ui.enterFullScreen('diagram'); e.preventDefault(); break; // f
            case 100:         diagram.toggleDescription(); e.preventDefault(); break; // d
            case 109:         diagram.toggleMetadata();   e.preventDefault(); break; // m
            case 105:         showKey();                  e.preventDefault(); break; // i
            case 116:         toggleTooltip();            e.preventDefault(); break; // t
            case 112:         openPerspectivesModal();    e.preventDefault(); break; // p
            case 98:          back();                     e.preventDefault(); break; // b
            case 44:          // ,
                if (diagram.currentViewIsDynamic() || diagram.currentViewHasAnimation()) {
                    stepBackwardInAnimation(); e.preventDefault();
                } break;
            case 46:          // .
                if (diagram.currentViewIsDynamic() || diagram.currentViewHasAnimation()) {
                    stepForwardInAnimation(); e.preventDefault();
                } break;
        }
    });

    // Ctrl+scroll → zoom
    document.getElementById('diagram').addEventListener('wheel', function(e) {
        if (e.ctrlKey) {
            e.deltaY < 0 ? diagram.zoomIn(e) : diagram.zoomOut(e);
            e.preventDefault();
            e.stopPropagation();
        }
    }, { passive: false });
}

// ── Toolbar button wiring ──────────────────────────────────────────────────
$('#homeButton').on('click', function() {
    showHome();
    scheduleThumbnailGeneration(views.slice());
    postToSwift({ type: 'viewChanged', key: '' });
});
$('#backButton').on('click', back);
$('#diagramKeyButton').on('click', showKey);
$('#diagramTooltipOnButton').on('click', toggleTooltip);
$('#diagramTooltipOffButton').on('click', toggleTooltip);
$('#filterOnButton').on('click', function() {
    openFilterModal();
    $('#filterOnButton').addClass('hidden');
    $('#filterOffButton').removeClass('hidden');
});
$('#filterOffButton').on('click', openFilterModal);
$('#perspectivesOnButton').on('click', openPerspectivesModal);
$('#perspectivesOffButton').on('click', openPerspectivesModal);
$('#exportImagesButton').on('click', function() { $('#exportModal').modal('show'); });
$('#exportSvgButton').on('click', function() { exportSelectedViews('svg'); });
$('#exportPngButton').on('click', function() { exportSelectedViews('png'); });
$('#zoomInButton, #zoomInBtn2').on('click', function() { if (diagram) diagram.zoomIn(); });
$('#zoomOutButton, #zoomOutBtn2').on('click', function() { if (diagram) diagram.zoomOut(); });
$('#enterFullScreenButton').on('click', function() {
    structurizr.ui.enterFullScreen('diagram');
    $('#enterFullScreenButton').addClass('hidden');
    $('#exitFullScreenButton').removeClass('hidden');
});
$('#exitFullScreenButton').on('click', function() {
    structurizr.ui.exitFullScreen();
    $('#enterFullScreenButton').removeClass('hidden');
    $('#exitFullScreenButton').addClass('hidden');
});
$('#stepBackwardInAnimationButton').on('click', stepBackwardInAnimation);
$('#startAnimationButton').on('click', function() { startAnimation(); });
$('#stopAnimationButton').on('click', function() { stopAnimation(); });
$('#stepForwardInAnimationButton').on('click', stepForwardInAnimation);

// Dark mode toggles (toolbar + nav panel)
function setRenderingMode(mode) {
    structurizr.ui.setRenderingMode(mode);
    if (diagram) diagram.setDarkMode(structurizr.ui.isDarkMode());
}
$('#renderingModeLightLink, #renderingModeLightLink2').on('click', function(e) {
    e.preventDefault(); setRenderingMode(structurizr.ui.RENDERING_MODE_LIGHT);
});
$('#renderingModeDarkLink, #renderingModeDarkLink2').on('click', function(e) {
    e.preventDefault(); setRenderingMode(structurizr.ui.RENDERING_MODE_DARK);
});
$('#renderingModeSystemLink, #renderingModeSystemLink2').on('click', function(e) {
    e.preventDefault(); setRenderingMode(structurizr.ui.RENDERING_MODE_SYSTEM);
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
    if (structurizr.ui.getRenderingMode() === structurizr.ui.RENDERING_MODE_SYSTEM) {
        if (diagram) diagram.setDarkMode(structurizr.ui.isDarkMode());
    }
});

// ── Resize handler ────────────────────────────────────────────────────────
window.addEventListener('resize', function() { resize(); });

// ── Console forwarding (for Swift debugging) ──────────────────────────────
(function() {
    var _log = console.log.bind(console);
    console.log = function() {
        _log.apply(console, arguments);
        postToSwift({ type: 'console', level: 'log', msg: Array.from(arguments).join(' ') });
    };
    var _err = console.error.bind(console);
    console.error = function() {
        _err.apply(console, arguments);
        postToSwift({ type: 'console', level: 'error', msg: Array.from(arguments).join(' ') });
    };
})();

// ── Signal to Swift that JS is fully initialised and renderDiagram is live ──
postToSwift({ type: 'jsReady' });
