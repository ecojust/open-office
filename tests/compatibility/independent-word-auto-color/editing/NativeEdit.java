import com.sun.star.comp.helper.Bootstrap;
import com.sun.star.uno.*;
import com.sun.star.bridge.XUnoUrlResolver;
import com.sun.star.lang.XMultiComponentFactory;
import com.sun.star.lang.XComponent;
import com.sun.star.beans.PropertyValue;
import com.sun.star.beans.XPropertySet;
import com.sun.star.frame.*;
import com.sun.star.text.*;
import com.sun.star.awt.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
public class NativeEdit {
 static <T> T qi(Class<T> c,Object o){return UnoRuntime.queryInterface(c,o);}
 static PropertyValue prop(String n,Object v){PropertyValue p=new PropertyValue();p.Name=n;p.Value=v;return p;}
 static String url(String p){return Path.of(p).toAbsolutePath().toUri().toString();}
 static void edit(XComponentLoader loader,XMultiComponentFactory sm,XComponentContext ctx,String input,String output,String actions) throws java.lang.Exception {
  XComponent doc=loader.loadComponentFromURL(url(input),"_blank",0,new PropertyValue[]{prop("Hidden",false),prop("ReadOnly",false)});
  try {
   XModel model=qi(XModel.class,doc); XFrame frame=model.getCurrentController().getFrame();
   XDispatchHelper helper=qi(XDispatchHelper.class,sm.createInstanceWithContext("com.sun.star.frame.DispatchHelper",ctx));
   XDispatchProvider provider=qi(XDispatchProvider.class,frame);
   Object toolkit=sm.createInstanceWithContext("com.sun.star.awt.Toolkit",ctx);
   XToolkitRobot robot=qi(XToolkitRobot.class,toolkit);
   XToolkitExperimental events=qi(XToolkitExperimental.class,toolkit);
   frame.getContainerWindow().setVisible(true);frame.getComponentWindow().setFocus();
   XTextViewCursor cursor=qi(XTextViewCursorSupplier.class,model.getCurrentController()).getViewCursor();
   for(String line:Files.readAllLines(Path.of(actions))){
    if(line.isBlank()||line.startsWith("#")) continue;
    String[] a=line.split("\t",-1);System.out.println("ACTION "+line);
    XText text=qi(XTextDocument.class,doc).getText();
    XTextCursor start=text.createTextCursor();start.gotoStart(false);start.gotoRange(cursor.getStart(),true);
    XTextCursor end=text.createTextCursor();end.gotoStart(false);end.gotoRange(cursor.getEnd(),true);
    System.out.println("SELECTION "+start.getString().length()+":"+end.getString().length()+" "+Base64.getEncoder().encodeToString(cursor.getString().getBytes(StandardCharsets.UTF_8)));
    XPropertySet cp=qi(XPropertySet.class,cursor);
    for(String pn:new String[]{"CharWeight","CharPosture","CharHeight","CharColor","CharUnderline","CharBackColor","CharEscapement","CharStyleName","ParaStyleName"})System.out.println("PROPERTY "+pn+"="+cp.getPropertyValue(pn));
    switch(a[0]) {
     case "cursor": cursor.gotoStart(false);cursor.goRight(Short.parseShort(a[1]),false);if(a.length>2)cursor.goRight(Short.parseShort(a[2]),true);break;
     case "text": helper.executeDispatch(provider,".uno:InsertText","",0,new PropertyValue[]{prop("Text",a[1])});break;
     case "key":
      KeyEvent e=new KeyEvent();e.Source=frame.getComponentWindow();e.KeyCode=Short.parseShort(a[1]);e.Modifiers=a.length>3?Short.parseShort(a[3]):0;e.KeyChar=a.length>2&&!a[2].isEmpty()?a[2].charAt(0):0;
      robot.keyPress(e);robot.keyRelease(e);events.processEventsToIdle();break;
     case "snapshot":
      for(String[] fmt:new String[][]{{"docx","Office Open XML Text"},{"odt","writer8"},{"pdf","writer_pdf_Export"}})
       qi(XStorable.class,doc).storeToURL(url(a[1]+"."+fmt[0]),new PropertyValue[]{prop("FilterName",fmt[1]),prop("Overwrite",true)});
      System.out.println("SNAPSHOT "+a[1]);break;
     case "command":
      PropertyValue[] props=new PropertyValue[0];
      if(a.length>2){Object v=a[4];switch(a[3]){case "boolean":v=Boolean.parseBoolean(a[4]);break;case "int":v=Integer.parseInt(a[4]);break;case "short":v=Short.parseShort(a[4]);break;}props=new PropertyValue[]{prop(a[2],v)};}
      helper.executeDispatch(provider,a[1],"",0,props);break;
     default: throw new IllegalArgumentException("Unknown action: "+line);
    }
   }
   System.out.println("TEXT64 "+Base64.getEncoder().encodeToString(qi(XTextDocument.class,doc).getText().getString().getBytes(StandardCharsets.UTF_8)));
   for(String[] fmt:new String[][]{{"docx","Office Open XML Text"},{"odt","writer8"},{"pdf","writer_pdf_Export"}})
    qi(XStorable.class,doc).storeToURL(url(output+"."+fmt[0]),new PropertyValue[]{prop("FilterName",fmt[1]),prop("Overwrite",true)});
   System.out.println("SAVED "+output);
  } finally {doc.dispose();}
 }
 public static void main(String[] args) throws java.lang.Exception {
  XComponentContext local=Bootstrap.createInitialComponentContext(null);
  XUnoUrlResolver resolver=qi(XUnoUrlResolver.class,local.getServiceManager().createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver",local));
  XComponentContext ctx=qi(XComponentContext.class,resolver.resolve("uno:socket,host=127.0.0.1,port=20981;urp;StarOffice.ComponentContext"));
  XMultiComponentFactory sm=ctx.getServiceManager();Object desktop=sm.createInstanceWithContext("com.sun.star.frame.Desktop",ctx);
  try {
   XComponentLoader loader=qi(XComponentLoader.class,desktop);
   for(String line:Files.readAllLines(Path.of(args[0]))){if(line.isBlank()||line.startsWith("#"))continue;String[] a=line.split("\t");System.out.println("CASE "+a[1]);edit(loader,sm,ctx,a[0],a[1],a[2]);}
  } finally {qi(XDesktop.class,desktop).terminate();}
 }
}
