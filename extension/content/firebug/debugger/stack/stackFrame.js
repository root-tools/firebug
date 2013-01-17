/* See license.txt for terms of usage */

define([
    "firebug/lib/trace",
    "firebug/lib/url",
    "firebug/lib/locale",
    "firebug/lib/string",
    "firebug/debugger/script/sourceLink",
    "firebug/debugger/grips/scopeGrip",
],
function (FBTrace, Url, Locale, Str, SourceLink, ScopeGrip) {

// ********************************************************************************************* //
// Constants

var TraceError = FBTrace.to("DBG_ERRORS");
var Trace = FBTrace.to("DBG_STACK");

// ********************************************************************************************* //
// Stack Frame

// xxxHonza: should be derived from Grip
function StackFrame(sourceFile, lineNo, functionName, args, nativeFrame, pc, context, newestFrame)
{
    // Essential fields
    this.sourceFile = sourceFile;
    this.line = lineNo;

    //var fn = StackFrame.getDisplayName(nativeFrame ? nativeFrame.scope : null);
    //this.fn = fn || functionName;  // cache?
    this.fn = functionName;  // cache?

    this.context = context;

    // the newest frame in the stack containing 'this' frame
    this.newestFrame = (newestFrame ? newestFrame : this);

    // optional
    this.args = args;

    // Derived from sourceFile
    this.href = sourceFile.href;

    // Mozilla
    this.nativeFrame = nativeFrame;
    this.pc = pc;
    this.script = nativeFrame ? nativeFrame.script : null;  // TODO-XB
};

StackFrame.prototype =
{
    getURL: function()
    {
        return this.href;
    },

    getCompilationUnit: function()
    {
        return this.context.getCompilationUnit(this.href);
    },

    getStackNewestFrame: function()
    {
        return this.newestFrame;
    },

    getFunctionName: function()
    {
        return this.fn;
    },

    toSourceLink: function()
    {
        return new SourceLink(this.sourceFile.href, this.line, "js");
    },

    toString: function()
    {
        return this.fn + ", " +
            (this.sourceFile ? this.sourceFile.href : "no source file") +
            "@" + this.line;
    },

    setCallingFrame: function(caller, frameIndex)
    {
        this.callingFrame = caller;
        this.frameIndex = frameIndex;
    },

    getCallingFrame: function()
    {
        if (FBTrace.DBG_STACK)
            FBTrace.sysout("getCallingFrame "+this, this);

        if (!this.callingFrame && this.nativeFrame && this.nativeFrame.isValid)
        {
            var nativeCallingFrame = this.nativeFrame.callingFrame;
            if (nativeCallingFrame)
                this.callingFrame = StackFrame.getStackFrame(nativeCallingFrame, this.context,
                    this.newestFrame);
        }
        return this.callingFrame;
    },

    getFrameIndex: function()
    {
        return this.frameIndex;
    },

    getLineNumber: function()
    {
        return this.line;
    },

    destroy: function()
    {
        if (FBTrace.DBG_STACK)
            FBTrace.sysout("StackFrame destroyed:"+this.uid+"\n");

        this.script = null;
        this.nativeFrame = null;
        this.context = null;
    },

    signature: function()
    {
        return this.getActor();
    },

    getActor: function()
    {
        return this.nativeFrame.actor;
    },

    getScopes: function()
    {
        if (this.scopes)
            return this.scopes;

        this.scopes = [];

        var cache = this.context.gripCache;

        // Append 'this' as the first scope. This is not a real 'scope',
        // but useful for debugging.
        var thisScope = cache.getObject(this.nativeFrame["this"]);
        thisScope.name = "this";
        this.scopes.push(thisScope);

        // Now iterate all parent scopes. This represents the chain of scopes
        // in the Watch panel.
        var scope = this.nativeFrame.environment;
        while (scope)
        {
            this.scopes.push(new ScopeGrip(scope, cache));
            scope = scope.parent;
        }

        return this.scopes;
    },

    getTopScope: function()
    {
        var scopes = this.getScopes();
        return (scopes.length > 1) ? scopes[1] : null;
    }
};

// ********************************************************************************************* //
// Static Methods

StackFrame.getStackDump = function()
{
    var lines = [];
    for (var frame = Components.stack; frame; frame = frame.caller)
        lines.push(frame.filename + " (" + frame.lineNumber + ")");

    return lines.join("\n");
};

StackFrame.getStackSourceLink = function()
{
    for (var frame = Components.stack; frame; frame = frame.caller)
    {
        if (frame.filename && frame.filename.indexOf("://firebug/") > 0)
        {
            for (; frame; frame = frame.caller)
            {
                var firebugComponent = "/modules/firebug-";
                if (frame.filename && frame.filename.indexOf("://firebug/") < 0 &&
                    frame.filename.indexOf(firebugComponent) == -1)
                    break;
            }
            break;
        }
    }
    return StackFrame.getFrameSourceLink(frame);
}

StackFrame.buildStackFrame = function(frame, context)
{
    if (!frame)
    {
        TraceError.sysout("stackFrame.buildStackFrame; ERROR no frame!");
        return;
    }

    var sourceFile = context.sourceFileMap[frame.where.url];
    if (!sourceFile)
        sourceFile = {href: frame.where.url};

    var args = [];
    var arguments = frame.arguments;
    for (var i=0; i<arguments.length; i++)
    {
        args.push({
            name: getArgName(arguments[i]),
            value: getArgValue(frame.arguments[i])
        });
    }

    var funcName = frame.callee ? frame.callee.name : "";
    return new StackFrame(sourceFile, frame.where.line, funcName,
        args, frame, 0, context);
};

StackFrame.guessFunctionName = function(url, lineNo, sourceFile)
{
    if (sourceFile)
        return StackFrame.guessFunctionNameFromLines(url, lineNo, sourceFile);

    return "? in " + Url.getFileName(url) + "@" + lineNo;
}

var reGuessFunction = /['"]?([$0-9A-Za-z_]+)['"]?\s*[:=]\s*(function|eval|new Function)/;
var reFunctionArgNames = /function ([^(]*)\(([^)]*)\)/;
StackFrame.guessFunctionNameFromLines = function(url, lineNo, sourceFile)
{
    // Walk backwards from the first line in the function until we find the line which
    // matches the pattern above, which is the function definition
    var line = "";
    for (var i = 0; i < 4; ++i)
    {
        line = sourceFile.getLine(lineNo - i) + line;
        if (line != undefined)
        {
            var m = reGuessFunction.exec(line);
            if (m)
            {
                return m[1];
            }
            else
            {
                if (FBTrace.DBG_FUNCTION_NAMES)
                    FBTrace.sysout("lib.guessFunctionName re failed for lineNo-i="+lineNo+
                        "-"+i+" line="+line+"\n");
            }

            m = reFunctionArgNames.exec(line);
            if (m && m[1])
                return m[1];
        }
    }

    return Url.getFileName(url) + "@" + lineNo;
}

// ********************************************************************************************* //
// Helpers

function getArgName(arg)
{
    for (var p in arg)
        return p;
}

function getArgValue(arg)
{
    return arg["class"] ? arg["class"] : arg;
}

// ********************************************************************************************* //
// JSD1 Artifacts

StackFrame.suspendShowStackTrace = function(){}
StackFrame.resumeShowStackTrace = function(){}

// ********************************************************************************************* //

var reErrorStackLine = /^(.*)@(.*):(\d*)$/;
var reErrorStackLine2 = /^([^\(]*)\((.*)\)$/;

// function name (arg, arg, arg)@fileName:lineNo
StackFrame.parseToStackFrame = function(line, context)
{
    var last255 = line.length - 255;
    if (last255 > 0)
        line = line.substr(last255);   // avoid regexp on monster compressed source (issue 4135)

    var m = reErrorStackLine.exec(line);
    if (m)
    {
        var m2 = reErrorStackLine2.exec(m[1]);
        if (m2)
        {
            var params = m2[2].split(',');
            //FBTrace.sysout("parseToStackFrame",{line:line,paramStr:m2[2],params:params});
            //var params = JSON.parse("["+m2[2]+"]");
            return new StackFrame.StackFrame({href:m[2]}, m[3], m2[1],
                params, null, null, context);
        }
        else
        {
            // Firefox 14 removes arguments from <exception-object>.stack.toString()
            // That's why the m2 reg doesn't match
            // See: https://bugzilla.mozilla.org/show_bug.cgi?id=744842
            return new StackFrame.StackFrame({href:m[2]}, m[3], m[1], [], null, null, context);
        }
    }
};

StackFrame.parseToStackTrace = function(stack, context)
{
     var lines = stack.split('\n');
     var trace = new StackFrame.StackTrace();
     for (var i = 0; i < lines.length; i++)
     {
         var frame = StackFrame.parseToStackFrame(lines[i],context);

         if (FBTrace.DBG_STACK)
             FBTrace.sysout("parseToStackTrace i "+i+" line:"+lines[i]+ "->frame: "+frame, frame);

         if (frame)
             trace.frames.push(frame);
     }
     return trace;
};

StackFrame.cleanStackTraceOfFirebug = function(trace)
{
    if (trace && trace.frames)
    {
        var count = trace.frames.length - 1;
        while (trace.frames.length && (/^_[fF]irebug/.test(trace.frames[count].fn) ||
            /^\s*with\s*\(\s*_[fF]irebug/.test(trace.frames[count].sourceFile.source)))
        {
            trace.frames.pop();
        }

        if (trace.frames.length == 0)
            trace = undefined;
    }
    return trace;
};

StackFrame.getStackDump = function()
{
    var lines = [];
    for (var frame = Components.stack; frame; frame = frame.caller)
        lines.push(frame.filename + " (" + frame.lineNumber + ")");

    return lines.join("\n");
};

StackFrame.getJSDStackDump = function(newestFrame)
{
    var lines = [];
    for (var frame = newestFrame; frame; frame = frame.callingFrame)
        lines.push(frame.script.fileName + " (" + frame.line + ")");

    return lines.join("\n");
};

StackFrame.getStackSourceLink = function()
{
    for (var frame = Components.stack; frame; frame = frame.caller)
    {
        if (frame.filename && frame.filename.indexOf("://firebug/") > 0)
        {
            for (; frame; frame = frame.caller)
            {
                var firebugComponent = "/modules/firebug-";
                if (frame.filename && frame.filename.indexOf("://firebug/") < 0 &&
                    frame.filename.indexOf(firebugComponent) == -1)
                    break;
            }
            break;
        }
    }
    return StackFrame.getFrameSourceLink(frame);
};

StackFrame.getFrameSourceLink = function(frame)
{
    if (frame && frame.filename && frame.filename.indexOf("XPCSafeJSObjectWrapper") == -1)
        return new SourceLink.SourceLink(frame.filename, frame.lineNumber, "js");
    else
        return null;
};

// ********************************************************************************************* //
// Registration

return StackFrame;

// ********************************************************************************************* //
});
